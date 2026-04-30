import fs from 'fs';

export class MonitorOrchestrator {
  constructor(deps) {
    this.deps = deps;
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

    return {
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
  }
}
