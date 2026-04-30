import fs from 'fs';

export class MonitorOrchestrator {
  constructor(deps) {
    this.deps = deps;
    this.components = null;
  }

  start() {
    const {
      env,
      monitorDir,
      getActiveAdapter,
      readConfigObject,
      createToolPipeline,
      readWatchdogState,
      createProcSampler,
      loadInitialHealth,
      createHealthEngine,
      createGuardian,
      startMessageRouterServer,
      readDailyUpgradeEnabled,
      createUsageMonitor,
      createTaskScheduler,
      initializeUsageMonitor,
      startContextMonitor,
      scheduleStaleRuntimeCleanup,
      log,
      nowMs = () => Date.now(),
    } = this.deps;

    // PM2 dump can carry over stale tmux session references after reboot.
    delete env.TMUX;

    if (!fs.existsSync(monitorDir)) {
      fs.mkdirSync(monitorDir, { recursive: true });
    }

    const adapter = getActiveAdapter();
    const config = readConfigObject();
    const { pipeline: toolPipeline, toolRules } = createToolPipeline(adapter, config);
    const watchdogState = readWatchdogState();
    const procSampler = createProcSampler(adapter);

    const initialStatus = loadInitialHealth();
    const initialHealth = initialStatus.health;
    const runtimeLaunchAtMs = Number(initialStatus.runtime_launch_at) || nowMs();

    const engine = createHealthEngine(adapter, initialStatus);
    const guardian = createGuardian(adapter, toolPipeline, runtimeLaunchAtMs);

    if (initialHealth === 'rate_limited' && initialStatus.cooldown_until) {
      engine.enterRateLimited(initialStatus.cooldown_until, initialStatus.rate_limit_reset || '');
    }
    engine.start();

    startMessageRouterServer();

    if (!readDailyUpgradeEnabled()) {
      log('Daily upgrade: disabled (set `zylos config set daily_upgrade_enabled true` to enable)');
    }

    const usageMonitor = createUsageMonitor(adapter);
    const taskScheduler = createTaskScheduler(usageMonitor);
    initializeUsageMonitor(usageMonitor, adapter);

    const contextMonitor = startContextMonitor(adapter);

    if (initialHealth !== 'ok') {
      log(`Startup with health=${initialHealth}; will verify immediately when ${adapter.displayName} is running`);
    }

    scheduleStaleRuntimeCleanup(adapter);

    this.components = {
      adapter,
      toolRules,
      toolPipeline,
      watchdogState,
      procSampler,
      runtimeLaunchAtMs,
      engine,
      guardian,
      usageMonitor,
      taskScheduler,
      contextMonitor,
    };
    return this.components;
  }

  async tickRuntimeLiveness({ currentTime, checkDailyTruncate }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before tickRuntimeLiveness()');
    }

    checkDailyTruncate();

    const { engine, guardian } = this.components;
    const guardianResult = await guardian.tick({ currentTime });
    this.components.runtimeLaunchAtMs = guardianResult.runtimeLaunchAtMs;
    engine.setAgentRunning(guardianResult.state === 'running', currentTime);
    if (guardianResult.attempted_restart) {
      engine.onProcessRestarted(currentTime);
    }

    return {
      guardianResult,
      runtimeLaunchAtMs: this.components.runtimeLaunchAtMs,
    };
  }

  handleNotRunningRuntime({
    guardianResult,
    currentTime,
    currentTimeHuman,
    lastState,
    buildNotRunningStatus,
    writeStatusFile,
    clearWatchdogState,
    nowMs = () => Date.now(),
  }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before handleNotRunningRuntime()');
    }

    const { adapter, engine, taskScheduler, toolPipeline } = this.components;
    const state = guardianResult.state;

    writeStatusFile(buildNotRunningStatus({
      state,
      currentTime,
      currentTimeHuman,
      guardianResult,
      runtimeLaunchAtMsValue: this.components.runtimeLaunchAtMs,
    }));

    if (state === 'stopped' && adapter.runtimeId === 'claude') {
      clearWatchdogState();
      toolPipeline.writeApiActivitySnapshot({
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
        updated_at: nowMs(),
        oldest_active_tool: null,
        watchdog_candidate_tool: null,
        last_completed_tool: null,
      });
    }

    if (state !== lastState) {
      if (state === 'offline') {
        this.deps.log('State: OFFLINE (tmux session not found)');
      } else {
        this.deps.log(`State: STOPPED (${adapter.displayName} not running in tmux session)`);
      }
    }

    taskScheduler.tick({
      currentTime,
      health: engine.health,
      agentRunning: false,
      state,
    });

    return { lastState: state };
  }
}
