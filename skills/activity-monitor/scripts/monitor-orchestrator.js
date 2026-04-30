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

  resolveActivitySource({ currentTime, getConversationFileModTime, getTmuxActivity }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before resolveActivitySource()');
    }

    const { adapter } = this.components;
    let activity = adapter.runtimeId === 'claude' ? getConversationFileModTime() : null;
    let source = 'conv_file';

    if (!activity) {
      activity = getTmuxActivity();
      source = 'tmux_activity';
    }

    if (!activity) {
      activity = currentTime;
      source = 'default';
    }

    return { activity, source };
  }

  summarizeApiActivity({ currentTime, apiActivity }) {
    const apiUpdatedSec = apiActivity?.updated_at ? Math.floor(apiActivity.updated_at / 1000) : 0;
    const activeTools = apiActivity?.active_tools ?? 0;
    const thinking = apiActivity?.active === true || activeTools > 0;
    const hookFresh = apiUpdatedSec > 0 && (currentTime - apiUpdatedSec) < 60;

    return {
      apiUpdatedSec,
      activeTools,
      thinking,
      hookFresh,
      confirmedActive: activeTools > 0 && hookFresh,
    };
  }

  mergeApiActivitySource({ activity, source, apiActivity, apiUpdatedSec }) {
    if (apiActivity?.active && apiUpdatedSec > activity) {
      return {
        activity: apiUpdatedSec,
        source: 'api_hook',
      };
    }

    return { activity, source };
  }

  readRuntimeInteraction({ getTmuxClaudePid, readTmuxInputState }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before readRuntimeInteraction()');
    }

    const { adapter } = this.components;
    return {
      currentTmuxClaudePid: adapter.runtimeId === 'claude'
        ? getTmuxClaudePid(adapter.sessionName)
        : 0,
      interactiveState: adapter.runtimeId === 'claude'
        ? readTmuxInputState({ sessionName: adapter.sessionName })
        : null,
    };
  }

  tickToolPipeline({ nowMs, currentTmuxClaudePid, interactiveState }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before tickToolPipeline()');
    }

    const { adapter, toolPipeline } = this.components;
    if (adapter.runtimeId !== 'claude') {
      return {
        foregroundIdentity: null,
        apiActivity: null,
      };
    }

    return toolPipeline.tick({
      nowMs,
      currentTmuxClaudePid,
      interactiveState,
    });
  }

  refreshDirtyApiActivity({ watchdogStatus, foregroundIdentity, currentTmuxClaudePid, apiActivity }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before refreshDirtyApiActivity()');
    }

    if (!watchdogStatus.api_activity_dirty) {
      return apiActivity;
    }

    const { toolPipeline } = this.components;
    const nextApiActivity = toolPipeline.buildApiActivity(foregroundIdentity, currentTmuxClaudePid);
    toolPipeline.writeApiActivitySnapshot(nextApiActivity);
    return nextApiActivity;
  }

  handleProcSampler({ currentTime, confirmedActive }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before handleProcSampler()');
    }

    const { adapter, procSampler } = this.components;
    procSampler.tick(currentTime, { isActive: confirmedActive });
    if (!procSampler.isFrozen()) {
      return { frozen: false };
    }

    this.deps.log(`Guardian: Process frozen (0 ctx_switch delta for ${procSampler.getState().frozenCount}s while active_tools > 0), killing session`);
    adapter.stop();
    procSampler.reset();
    // Guardian will detect offline on next tick and call startAgent().
    return { frozen: true, lastState: 'frozen' };
  }

  handleRunningRuntime({
    currentTime,
    currentTimeHuman,
    activity,
    source,
    apiUpdatedSec,
    activeTools,
    thinking,
    apiActivity,
    watchdogStatus,
    foregroundIdentity,
    lastState,
    idleSince,
    idleThreshold,
    buildRunningStatus,
    writeStatusFile,
  }) {
    if (!this.components) {
      throw new Error('MonitorOrchestrator.start() must be called before handleRunningRuntime()');
    }

    const { engine, taskScheduler } = this.components;
    const inactiveSeconds = currentTime - activity;
    const state = (activeTools > 0 || inactiveSeconds < idleThreshold) ? 'busy' : 'idle';

    let nextIdleSince = idleSince;
    if (state === 'idle' && lastState !== 'idle') {
      nextIdleSince = currentTime;
    } else if (state === 'busy') {
      nextIdleSince = 0;
    }

    const idleSeconds = state === 'idle' ? currentTime - nextIdleSince : 0;

    writeStatusFile(buildRunningStatus({
      state,
      thinking,
      activity,
      apiUpdatedSec,
      activeTools,
      currentTime,
      currentTimeHuman,
      idleSeconds,
      inactiveSeconds,
      source,
      runtimeLaunchAtMsValue: this.components.runtimeLaunchAtMs,
      apiActivity,
      watchdogStatus,
      foregroundIdentity,
    }));

    if (state !== lastState) {
      if (state === 'busy') {
        this.deps.log(`State: BUSY (last activity ${inactiveSeconds}s ago)`);
      } else {
        this.deps.log('State: IDLE (entering idle state)');
      }
    }

    taskScheduler.tick({
      currentTime,
      health: engine.health,
      agentRunning: true,
      state,
      idleSeconds,
      apiActivity,
    });

    return { lastState: state, idleSince: nextIdleSince };
  }
}
