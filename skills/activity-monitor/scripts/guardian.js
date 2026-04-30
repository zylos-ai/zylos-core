import { execSync as defaultExecSync } from 'child_process';

export const BASE_RESTART_DELAY = 5;
export const MAX_RESTART_DELAY = 60;
export const BACKOFF_RESET_THRESHOLD = 60;
export const STARTUP_GRACE_TICKS = 30;
export const MAINTENANCE_WAIT_TIMEOUT = 300;

export function getRunningMaintenance({ execSyncImpl = defaultExecSync } = {}) {
  try {
    execSyncImpl('pgrep -f "[r]estart-claude" > /dev/null 2>&1', { timeout: 500 });
    return 'restart-claude';
  } catch { }

  try {
    execSyncImpl('pgrep -f "[u]pgrade-claude" > /dev/null 2>&1', { timeout: 500 });
    return 'upgrade-claude';
  } catch { }

  try {
    execSyncImpl('pgrep -f "[c]laude.ai/install.sh" > /dev/null 2>&1', { timeout: 500 });
    return 'upgrade (curl install.sh)';
  } catch { }

  return null;
}

export function waitForMaintenance({
  log = () => {},
  execSyncImpl = defaultExecSync,
  maxWait = MAINTENANCE_WAIT_TIMEOUT,
} = {}) {
  let waited = 0;
  let scriptName = getRunningMaintenance({ execSyncImpl });
  if (!scriptName) return 0;

  log(`Guardian: Detected ${scriptName} running, waiting for completion...`);
  while (true) {
    scriptName = getRunningMaintenance({ execSyncImpl });
    if (!scriptName) break;

    if (waited >= maxWait) {
      log(`Guardian: Warning - ${scriptName} still running after ${maxWait}s, proceeding anyway`);
      break;
    }

    if (waited > 0 && waited % 30 === 0) {
      log(`Guardian: Still waiting for ${scriptName}... (${waited}s)`);
    }

    execSyncImpl('sleep 1', { timeout: 1500 });
    waited += 1;
  }

  if (waited > 0 && waited < maxWait) {
    log(`Guardian: maintenance completed after ${waited}s`);
  }
  return waited;
}

export function tmuxHasSession({ sessionName, execSyncImpl = defaultExecSync } = {}) {
  try {
    execSyncImpl(`tmux has-session -t "${sessionName}" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export class Guardian {
  constructor(adapter, deps = {}) {
    this.adapter = adapter;
    this.deps = {
      log: () => {},
      resetToolLifecycleState: () => {},
      execSyncImpl: defaultExecSync,
      nowMs: () => Date.now(),
      initialRuntimeLaunchAtMs: 0,
      ...deps,
    };
    this.notRunningCount = 0;
    this.consecutiveRestarts = 0;
    this.stableRunningSince = 0;
    this.startupGrace = 0;
    this.startAgentInProgress = false;
    this.runtimeLaunchAtMs = this.deps.initialRuntimeLaunchAtMs;
  }

  getState() {
    return {
      notRunningCount: this.notRunningCount,
      consecutiveRestarts: this.consecutiveRestarts,
      stableRunningSince: this.stableRunningSince,
      startupGrace: this.startupGrace,
      startAgentInProgress: this.startAgentInProgress,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
    };
  }

  async tick({ currentTime } = {}) {
    const hasSession = tmuxHasSession({
      sessionName: this.adapter.sessionName,
      execSyncImpl: this.deps.execSyncImpl,
    });

    if (!hasSession) {
      return this._handleNotRunning({
        state: 'offline',
        message: 'tmux session not found',
        restartLog: `Guardian: Session not found for {count}s, attempting to start ${this.adapter.displayName}...`,
      });
    }

    let agentRunning = false;
    try {
      agentRunning = await this.adapter.isRunning();
    } catch (err) {
      this.deps.log(`Guardian: adapter.isRunning() threw: ${err.message}`);
    }

    if (!agentRunning) {
      return this._handleNotRunning({
        state: 'stopped',
        message: `${this.adapter.displayName} not running in tmux`,
        restartLog: `Guardian: Agent not running for {count}s, attempting to start ${this.adapter.displayName}...`,
      });
    }

    this.startupGrace = 0;
    this.notRunningCount = 0;

    if (this.consecutiveRestarts > 0) {
      if (this.stableRunningSince === 0) {
        this.stableRunningSince = currentTime;
      } else if (currentTime - this.stableRunningSince >= BACKOFF_RESET_THRESHOLD) {
        this.consecutiveRestarts = 0;
        this.stableRunningSince = 0;
      }
    }

    return {
      state: 'running',
      attempted_restart: false,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
      notRunningSeconds: 0,
      message: null,
      skippedForStartupGrace: false,
    };
  }

  _handleNotRunning({ state, message, restartLog }) {
    if (this.startupGrace > 0) {
      this.startupGrace -= 1;
      return {
        state,
        attempted_restart: false,
        runtimeLaunchAtMs: this.runtimeLaunchAtMs,
        notRunningSeconds: this.notRunningCount,
        message,
        skippedForStartupGrace: true,
      };
    }

    this.notRunningCount += 1;
    this.stableRunningSince = 0;

    let attemptedRestart = false;
    const restartDelay = Math.min(
      BASE_RESTART_DELAY * Math.pow(2, this.consecutiveRestarts),
      MAX_RESTART_DELAY
    );
    if (this.notRunningCount >= restartDelay) {
      this.deps.log(restartLog.replace('{count}', String(this.notRunningCount)));
      attemptedRestart = this.startAgent();
    }

    return {
      state,
      attempted_restart: attemptedRestart,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
      notRunningSeconds: this.notRunningCount,
      message,
      skippedForStartupGrace: false,
    };
  }

  startAgent() {
    if (this.startAgentInProgress) return false;
    this.startAgentInProgress = true;

    try {
      if (getRunningMaintenance({ execSyncImpl: this.deps.execSyncImpl })) {
        this.deps.log('Guardian: Maintenance script detected, waiting for completion...');
        waitForMaintenance({
          log: this.deps.log,
          execSyncImpl: this.deps.execSyncImpl,
        });
      }

      this.consecutiveRestarts += 1;
      this.startupGrace = STARTUP_GRACE_TICKS;
      this.notRunningCount = 0;
      this.runtimeLaunchAtMs = this.deps.nowMs();

      this.deps.log(`Guardian: Starting ${this.adapter.displayName}...`);

      try {
        this.adapter.clearStaleState?.();
      } catch { }

      try {
        this.deps.resetToolLifecycleState();
      } catch { }

      this.adapter.launch().catch(err => {
        this.deps.log(`Guardian: Failed to start ${this.adapter.displayName}: ${err.message}`);
      });

      try {
        this.adapter.enqueueStartupPrompt?.();
      } catch { }

      return true;
    } finally {
      this.startAgentInProgress = false;
    }
  }
}
