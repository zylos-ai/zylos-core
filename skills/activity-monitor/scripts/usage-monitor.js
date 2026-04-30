import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { shouldStartUsageCheck } from './usage-check-engine.js';
import { readCodexUsageFromActiveRollout } from './usage-codex-rollout-reader.js';
import {
  readClaudeUsageFromMonitorFiles,
  readCodexUsageFromMonitorFile
} from './usage-monitor-file-reader.js';

export class UsageMonitor {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.options = options;
    this.lastUsageCheckAt = 0;
  }

  get runtimeId() {
    return this.adapter.runtimeId;
  }

  initializeLastCheckAt(nowEpoch) {
    const usageState = this.loadUsageState();
    if (this.runtimeId === 'codex') return 0;
    if (usageState?.lastCheckEpoch) return usageState.lastCheckEpoch;
    return nowEpoch;
  }

  isMonitorEnabled() {
    return this.options.monitorEnabled;
  }

  isAlertEnabled() {
    return this.options.alertEnabled;
  }

  getLastMonitorRunAt() {
    return this.lastUsageCheckAt;
  }

  getLastAlertRunAt() {
    const state = this.loadUsageAlertState();
    return state?.lastCheckedAt ? Math.floor(new Date(state.lastCheckedAt).getTime() / 1000) : 0;
  }

  canRunTask({ claudeState, idleSeconds, currentTime, apiActivity, activeHoursOnly = false }) {
    if (this.runtimeId !== 'claude' && this.runtimeId !== 'codex') return false;

    const promptUpdatedAt = apiActivity?.updated_at
      ? Math.floor(apiActivity.updated_at / 1000) : 0;
    return shouldStartUsageCheck({
      runtimeId: this.runtimeId,
      allowedRuntimeIds: ['claude', 'codex'],
      claudeState,
      idleSeconds,
      currentTime,
      lastUsageCheckAt: 0,
      checkInterval: { seconds: this.options.checkIntervalSec, idleGate: this.options.idleGateSec },
      inPrompt: this.runtimeId === 'claude' ? Boolean(apiActivity?.in_prompt) : false,
      promptUpdatedAt,
      localHour: this.options.getLocalHour(),
      activeHoursStart: activeHoursOnly ? this.options.activeHoursStart : 0,
      activeHoursEnd: activeHoursOnly ? this.options.activeHoursEnd : 24,
      pendingQueueCount: this.getPendingWorkCount(),
      lockBusy: false,
      backoffUntil: 0,
      circuitUntil: 0,
    });
  }

  runMonitor({ currentTime }) {
    let snapshot = null;
    let source = null;
    if (this.runtimeId === 'claude') {
      snapshot = readClaudeUsageFromMonitorFiles({
        statuslineFile: this.options.statuslineFile,
        usageStateFile: this.options.usageStateFile
      });
      source = snapshot?.statusShape || 'none';
    } else {
      snapshot = readCodexUsageFromMonitorFile({
        usageStateFile: this.options.usageCodexStateFile
      });
      source = snapshot?.statusShape || 'usage-codex-missing';

      if (!snapshot) {
        const rolloutStatus = readCodexUsageFromActiveRollout();
        if (rolloutStatus) {
          snapshot = {
            sessionPercent: rolloutStatus.sessionPercent,
            sessionResets: rolloutStatus.sessionResets,
            weeklyAllPercent: rolloutStatus.weeklyAllPercent,
            weeklyAllResets: rolloutStatus.weeklyAllResets,
            weeklySonnetPercent: null,
            weeklySonnetResets: null,
            fiveHourPercent: rolloutStatus.fiveHourPercent,
            fiveHourResets: rolloutStatus.fiveHourResets,
            statusShape: 'rollout_fallback'
          };
          source = snapshot.statusShape;
          this.options.log('Usage monitor (codex): usage-codex.json unavailable, falling back to rollout reader');
        }
      }
    }

    if (!snapshot) {
      this.options.log(`Usage monitor (${this.runtimeId}): no local usage snapshot available`);
      this.lastUsageCheckAt = currentTime;
      return true;
    }

    const usage = {
      session: snapshot.sessionPercent,
      sessionResets: snapshot.sessionResets,
      weeklyAll: snapshot.weeklyAllPercent,
      weeklyAllResets: snapshot.weeklyAllResets,
      weeklySonnet: snapshot.weeklySonnetPercent,
      weeklySonnetResets: snapshot.weeklySonnetResets,
      fiveHour: snapshot.fiveHourPercent,
      fiveHourResets: snapshot.fiveHourResets
    };
    const now = new Date().toISOString();
    const tierMetric = usage.weeklyAll ?? usage.session;
    const tier = this.getUsageTier(tierMetric ?? 0);

    const usageData = {
      lastCheck: now,
      lastCheckEpoch: currentTime,
      session: { percent: usage.session, resets: usage.sessionResets },
      weeklyAll: { percent: usage.weeklyAll, resets: usage.weeklyAllResets },
      weeklySonnet: { percent: usage.weeklySonnet, resets: usage.weeklySonnetResets },
      fiveHour: { percent: usage.fiveHour, resets: usage.fiveHourResets },
      tier,
      statusShape: source
    };

    this.options.log(
      `Usage monitor (${this.runtimeId}): source=${source} session=${usage.session ?? 'null'}% ` +
      `5h=${usage.fiveHour ?? 'null'}% weekly=${usage.weeklyAll ?? 'null'}% tier=${tier}`
    );

    this.writeUsageState(usageData);
    this.lastUsageCheckAt = currentTime;
    return true;
  }

  runAlert({ currentTime }) {
    const checkedAt = new Date(currentTime * 1000).toISOString();
    const alertState = this.loadUsageAlertState();
    const writeCheckedState = (patch = {}) => {
      this.writeUsageAlertState({
        version: 1,
        ...alertState,
        lastCheckedAt: checkedAt,
        sourceRuntime: this.runtimeId,
        ...patch
      });
    };

    const state = this.loadUsageState();
    if (!state) {
      this.options.log(`Usage alert (${this.runtimeId}): no usage state available`);
      writeCheckedState();
      return true;
    }

    const weekly = state.weeklyAll?.percent;
    if (weekly === null || weekly === undefined) {
      this.options.log(`Usage alert (${this.runtimeId}): no weekly usage metric available`);
      writeCheckedState();
      return true;
    }

    const tier = state.tier || this.getUsageTier(weekly);
    if (tier === 'ok') {
      writeCheckedState({ lastObservedTier: tier });
      return true;
    }

    const prevTier = alertState?.lastNotifiedTier || state.lastNotifiedTier || null;
    const prevNotifiedIso = alertState?.lastNotifiedAt || state.lastNotifiedAt || null;
    const prevNotifiedAt = prevNotifiedIso ? Math.floor(new Date(prevNotifiedIso).getTime() / 1000) : 0;
    const tierEscalated = prevTier !== tier && tierRank(tier) > tierRank(prevTier);
    const cooldownExpired = (currentTime - prevNotifiedAt) >= this.options.notifyCooldownSec;

    if (!tierEscalated && !cooldownExpired) {
      this.options.log(`Usage alert (${this.runtimeId}): suppressing notification (cooldown active, tier=${tier})`);
      writeCheckedState({ lastObservedTier: tier });
      return true;
    }

    const usage = {
      session: state.session?.percent,
      weeklyAll: state.weeklyAll?.percent,
      weeklySonnet: state.weeklySonnet?.percent,
      weeklyAllResets: state.weeklyAll?.resets
    };
    this.options.log(`Usage alert (${this.runtimeId}): notifying owner for tier=${tier}`);
    this.sendNotification(formatUsageNotification(usage, tier));
    writeCheckedState({
      lastObservedTier: tier,
      lastNotifiedTier: tier,
      lastNotifiedAt: new Date().toISOString(),
    });
    return true;
  }

  loadUsageState() {
    try {
      const stateFile = this.getUsageStateFile();
      if (!fs.existsSync(stateFile)) return null;
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch { }
    return null;
  }

  writeUsageState(data) {
    try {
      fs.writeFileSync(this.getUsageStateFile(), JSON.stringify(data, null, 2));
    } catch (err) {
      this.options.log(`Usage monitor: failed to write state (${err.message})`);
    }
  }

  getUsageStateFile() {
    if (this.runtimeId === 'codex') return this.options.usageCodexStateFile;
    return this.options.usageStateFile;
  }

  loadUsageAlertState() {
    try {
      if (!fs.existsSync(this.options.usageAlertStateFile)) return null;
      return JSON.parse(fs.readFileSync(this.options.usageAlertStateFile, 'utf8'));
    } catch { }
    return null;
  }

  writeUsageAlertState(data) {
    try {
      fs.writeFileSync(this.options.usageAlertStateFile, JSON.stringify(data, null, 2));
    } catch (err) {
      this.options.log(`Usage alert: failed to write state (${err.message})`);
    }
  }

  getPendingWorkCount() {
    try {
      const dbPath = path.join(this.options.zylosDir, 'comm-bridge', 'c4.db');
      if (!fs.existsSync(dbPath)) return 0;

      const out = execSync(
        `sqlite3 "${dbPath}" "SELECT ((SELECT COUNT(*) FROM control_queue WHERE status='pending') + (SELECT COUNT(*) FROM conversations WHERE direction='in' AND status='pending'))" 2>/dev/null`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();

      return parseInt(out || '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  getUsageTier(weeklyPercent) {
    if (weeklyPercent >= this.options.criticalThreshold) return 'critical';
    if (weeklyPercent >= this.options.highThreshold) return 'high';
    if (weeklyPercent >= this.options.warnThreshold) return 'warning';
    return 'ok';
  }

  sendNotification(message) {
    const content = `Usage alert received from activity monitor. Please forward this to the owner via their preferred DM channel:\n\n${message}`;
    const result = this.options.runC4Control([
      'enqueue',
      '--content', content,
      '--priority', '1',
      '--available-in', '5',
      '--no-ack-suffix'
    ]);
    if (result.ok) {
      this.options.log(`Usage monitor: notification enqueued (${result.output})`);
    } else {
      this.options.log(`Usage monitor: notification enqueue failed (${result.output})`);
    }
  }
}

function formatUsageNotification(usage, tier) {
  const weekly = usage.weeklyAll ?? 0;
  const session = usage.session ?? 0;
  const resets = usage.weeklyAllResets || 'unknown';

  const tierLabels = {
    warning: '⚠️ Usage Warning',
    high: '🔶 Usage High',
    critical: '🔴 Usage Critical'
  };

  const lines = [
    tierLabels[tier] || 'Usage Alert',
    '',
    `Weekly (all models): ${weekly}% used`,
    `Session: ${session}% used`
  ];

  if (usage.weeklySonnet !== undefined && usage.weeklySonnet !== null) {
    lines.push(`Weekly (Sonnet): ${usage.weeklySonnet}% used`);
  }

  lines.push(`Resets: ${resets}`);

  if (tier === 'critical') {
    lines.push('', 'Approaching plan limit. Consider reducing activity to avoid interruption.');
  } else if (tier === 'high') {
    lines.push('', 'Usage is elevated. Monitor closely.');
  }

  return lines.join('\n');
}

function tierRank(tier) {
  const ranks = { ok: 0, warning: 1, high: 2, critical: 3 };
  return ranks[tier] ?? 0;
}
