import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MonitorOrchestrator } from '../monitor-orchestrator.js';

describe('MonitorOrchestrator', () => {
  function createHarness(overrides = {}) {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-monitor-orchestrator-'));
    fs.rmSync(monitorDir, { recursive: true, force: true });

    const calls = [];
    const env = { TMUX: '/tmp/stale-tmux' };
    const adapter = overrides.adapter ?? { runtimeId: 'codex', displayName: 'Codex', sessionName: 'codex-main' };
    const config = { runtime: 'codex' };
    const toolPipeline = overrides.toolPipeline ?? { id: 'toolPipeline' };
    const toolRules = { id: 'toolRules' };
    const watchdogState = { id: 'watchdogState' };
    const procSampler = { id: 'procSampler' };
    const usageMonitor = {
      id: 'usageMonitor',
      initializeLastCheckAt: () => 900,
      lastUsageCheckAt: 0,
    };
    const taskScheduler = overrides.taskScheduler ?? { id: 'taskScheduler' };
    const contextMonitor = { id: 'contextMonitor' };
    const guardian = overrides.guardian ?? { id: 'guardian' };
    const engine = overrides.engine ?? {
      id: 'engine',
      enterRateLimited: (cooldownUntil, resetTime) => calls.push(['enterRateLimited', cooldownUntil, resetTime]),
      start: () => calls.push(['engine.start']),
    };

    const orchestrator = new MonitorOrchestrator({
      env,
      monitorDir,
      getActiveAdapter: () => adapter,
      readConfigObject: () => config,
      createToolPipeline: (activeAdapter, activeConfig) => {
        calls.push(['createToolPipeline', activeAdapter, activeConfig]);
        return { pipeline: toolPipeline, toolRules };
      },
      readWatchdogState: () => watchdogState,
      createProcSampler: (activeAdapter) => {
        calls.push(['createProcSampler', activeAdapter]);
        return procSampler;
      },
      loadInitialHealth: () => ({
        health: overrides.initialHealth ?? 'rate_limited',
        cooldown_until: 1234,
        rate_limit_reset: '12:30',
        runtime_launch_at: 5678,
      }),
      createHealthEngine: (activeAdapter, initialStatus) => {
        calls.push(['createHealthEngine', activeAdapter, initialStatus.health]);
        return engine;
      },
      createGuardian: (activeAdapter, activeToolPipeline, runtimeLaunchAtMs) => {
        calls.push(['createGuardian', activeAdapter, activeToolPipeline, runtimeLaunchAtMs]);
        return guardian;
      },
      startMessageRouterServer: () => calls.push(['startMessageRouterServer']),
      readDailyUpgradeEnabled: () => false,
      createUsageMonitor: (activeAdapter) => {
        calls.push(['createUsageMonitor', activeAdapter]);
        return usageMonitor;
      },
      createTaskScheduler: (activeUsageMonitor) => {
        calls.push(['createTaskScheduler', activeUsageMonitor]);
        return taskScheduler;
      },
      initializeUsageMonitor: (activeUsageMonitor, activeAdapter) => {
        calls.push(['initializeUsageMonitor', activeUsageMonitor, activeAdapter]);
        activeUsageMonitor.lastUsageCheckAt = activeUsageMonitor.initializeLastCheckAt();
      },
      startContextMonitor: (activeAdapter) => {
        calls.push(['startContextMonitor', activeAdapter]);
        return contextMonitor;
      },
      scheduleStaleRuntimeCleanup: (activeAdapter) => calls.push(['scheduleStaleRuntimeCleanup', activeAdapter]),
      log: overrides.log ?? ((message) => calls.push(['log', message])),
      nowMs: () => 1111,
    });

    return {
      adapter,
      calls,
      contextMonitor,
      engine,
      env,
      guardian,
      monitorDir,
      orchestrator,
      procSampler,
      taskScheduler,
      toolPipeline,
      toolRules,
      usageMonitor,
      watchdogState,
    };
  }

  it('assembles startup components and preserves startup side effects', () => {
    const {
      adapter,
      calls,
      contextMonitor,
      engine,
      env,
      guardian,
      monitorDir,
      orchestrator,
      procSampler,
      taskScheduler,
      toolPipeline,
      toolRules,
      usageMonitor,
      watchdogState,
    } = createHarness();

    const result = orchestrator.start();

    assert.equal(env.TMUX, undefined);
    assert.equal(fs.existsSync(monitorDir), true);
    assert.deepEqual(result, {
      adapter,
      toolRules,
      toolPipeline,
      watchdogState,
      procSampler,
      runtimeLaunchAtMs: 5678,
      engine,
      guardian,
      usageMonitor,
      taskScheduler,
      contextMonitor,
    });
    assert.equal(usageMonitor.lastUsageCheckAt, 900);
    assert.deepEqual(calls.map(([name]) => name), [
      'createToolPipeline',
      'createProcSampler',
      'createHealthEngine',
      'createGuardian',
      'enterRateLimited',
      'engine.start',
      'startMessageRouterServer',
      'log',
      'createUsageMonitor',
      'createTaskScheduler',
      'initializeUsageMonitor',
      'startContextMonitor',
      'log',
      'scheduleStaleRuntimeCleanup',
    ]);
  });

  it('coordinates runtime liveness tick and restart signaling', async () => {
    const calls = [];
    const engine = {
      id: 'engine',
      start: () => calls.push(['engine.start']),
      setAgentRunning: (running, currentTime) => calls.push(['setAgentRunning', running, currentTime]),
      onProcessRestarted: (currentTime) => calls.push(['onProcessRestarted', currentTime]),
    };
    const guardian = {
      id: 'guardian',
      tick: async ({ currentTime }) => {
        calls.push(['guardian.tick', currentTime]);
        return {
          state: 'running',
          attempted_restart: true,
          runtimeLaunchAtMs: 9876,
        };
      },
    };
    const { orchestrator } = createHarness({ engine, guardian, initialHealth: 'ok' });
    orchestrator.start();

    const result = await orchestrator.tickRuntimeLiveness({
      currentTime: 123,
      checkDailyTruncate: () => calls.push(['checkDailyTruncate']),
    });

    assert.deepEqual(result, {
      guardianResult: {
        state: 'running',
        attempted_restart: true,
        runtimeLaunchAtMs: 9876,
      },
      runtimeLaunchAtMs: 9876,
    });
    assert.deepEqual(calls, [
      ['engine.start'],
      ['checkDailyTruncate'],
      ['guardian.tick', 123],
      ['setAgentRunning', true, 123],
      ['onProcessRestarted', 123],
    ]);
  });

  it('writes not-running status and scheduler tick without cleanup for offline state', () => {
    const calls = [];
    const engine = {
      id: 'engine',
      health: 'recovering',
      start: () => calls.push(['engine.start']),
    };
    const taskScheduler = {
      id: 'taskScheduler',
      tick: (payload) => calls.push(['taskScheduler.tick', payload]),
    };
    const { orchestrator } = createHarness({
      engine,
      taskScheduler,
      initialHealth: 'ok',
      log: (message) => calls.push(['log', message]),
    });
    orchestrator.start();
    calls.length = 0;

    const result = orchestrator.handleNotRunningRuntime({
      guardianResult: {
        state: 'offline',
        notRunningSeconds: 12,
        message: 'tmux missing',
      },
      currentTime: 123,
      currentTimeHuman: '2026-04-30 12:00:00',
      lastState: 'running',
      buildNotRunningStatus: (payload) => {
        calls.push(['buildNotRunningStatus', payload]);
        return { status: 'not-running', state: payload.state };
      },
      writeStatusFile: (status) => calls.push(['writeStatusFile', status]),
      clearWatchdogState: () => calls.push(['clearWatchdogState']),
    });

    assert.deepEqual(result, { lastState: 'offline' });
    assert.deepEqual(calls, [
      ['buildNotRunningStatus', {
        state: 'offline',
        currentTime: 123,
        currentTimeHuman: '2026-04-30 12:00:00',
        guardianResult: {
          state: 'offline',
          notRunningSeconds: 12,
          message: 'tmux missing',
        },
        runtimeLaunchAtMsValue: 5678,
      }],
      ['writeStatusFile', { status: 'not-running', state: 'offline' }],
      ['log', 'State: OFFLINE (tmux session not found)'],
      ['taskScheduler.tick', {
        currentTime: 123,
        health: 'recovering',
        agentRunning: false,
        state: 'offline',
      }],
    ]);
  });

  it('clears watchdog state and writes stop snapshot for stopped Claude runtime', () => {
    const calls = [];
    const engine = {
      id: 'engine',
      health: 'ok',
      start: () => calls.push(['engine.start']),
    };
    const taskScheduler = {
      id: 'taskScheduler',
      tick: (payload) => calls.push(['taskScheduler.tick', payload]),
    };
    const toolPipeline = {
      id: 'toolPipeline',
      writeApiActivitySnapshot: (snapshot) => calls.push(['writeApiActivitySnapshot', snapshot]),
    };
    const { orchestrator } = createHarness({
      adapter: { runtimeId: 'claude', displayName: 'Claude', sessionName: 'claude-main' },
      engine,
      taskScheduler,
      toolPipeline,
      initialHealth: 'ok',
      log: (message) => calls.push(['log', message]),
    });
    orchestrator.start();
    calls.length = 0;

    const result = orchestrator.handleNotRunningRuntime({
      guardianResult: {
        state: 'stopped',
        notRunningSeconds: 7,
        message: 'process missing',
      },
      currentTime: 456,
      currentTimeHuman: '2026-04-30 12:01:00',
      lastState: 'busy',
      buildNotRunningStatus: (payload) => ({ status: 'not-running', state: payload.state }),
      writeStatusFile: (status) => calls.push(['writeStatusFile', status]),
      clearWatchdogState: () => calls.push(['clearWatchdogState']),
      nowMs: () => 9999,
    });

    assert.deepEqual(result, { lastState: 'stopped' });
    assert.deepEqual(calls, [
      ['writeStatusFile', { status: 'not-running', state: 'stopped' }],
      ['clearWatchdogState'],
      ['writeApiActivitySnapshot', {
        version: 3,
        pid: 0,
        sessionId: null,
        scope: null,
        foreground_identity: {
          session_id: null,
          source: null,
          trusted: false,
          observed_at: 0,
        },
        event: 'stop',
        tool: null,
        active: false,
        active_tools: 0,
        in_prompt: false,
        updated_at: 9999,
        oldest_active_tool: null,
        watchdog_candidate_tool: null,
        last_completed_tool: null,
      }],
      ['log', 'State: STOPPED (Claude not running in tmux session)'],
      ['taskScheduler.tick', {
        currentTime: 456,
        health: 'ok',
        agentRunning: false,
        state: 'stopped',
      }],
    ]);
  });
});
