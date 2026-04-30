import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MonitorOrchestrator } from '../monitor-orchestrator.js';

describe('MonitorOrchestrator', () => {
  it('assembles startup components and preserves startup side effects', () => {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-monitor-orchestrator-'));
    fs.rmSync(monitorDir, { recursive: true, force: true });

    const calls = [];
    const env = { TMUX: '/tmp/stale-tmux' };
    const adapter = { runtimeId: 'codex', displayName: 'Codex', sessionName: 'codex-main' };
    const config = { runtime: 'codex' };
    const toolPipeline = { id: 'toolPipeline' };
    const toolRules = { id: 'toolRules' };
    const watchdogState = { id: 'watchdogState' };
    const procSampler = { id: 'procSampler' };
    const engine = {
      id: 'engine',
      enterRateLimited: (cooldownUntil, resetTime) => calls.push(['enterRateLimited', cooldownUntil, resetTime]),
      start: () => calls.push(['engine.start']),
    };
    const guardian = { id: 'guardian' };
    const usageMonitor = {
      id: 'usageMonitor',
      initializeLastCheckAt: () => 900,
      lastUsageCheckAt: 0,
    };
    const taskScheduler = { id: 'taskScheduler' };
    const contextMonitor = { id: 'contextMonitor' };

    const result = new MonitorOrchestrator({
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
        health: 'rate_limited',
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
      log: (message) => calls.push(['log', message]),
      nowMs: () => 1111,
    }).start();

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
});
