import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'node:test';
import { UsageMonitor } from '../usage-monitor.js';

const tmpDirs = [];

function makeMonitor(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-'));
  tmpDirs.push(dir);
  const calls = { log: [], control: [] };
  const monitor = new UsageMonitor(
    { runtimeId: overrides.runtimeId || 'claude' },
    {
      zylosDir: dir,
      statuslineFile: path.join(dir, 'statusline.json'),
      usageStateFile: path.join(dir, 'usage.json'),
      usageCodexStateFile: path.join(dir, 'usage-codex.json'),
      usageAlertStateFile: path.join(dir, 'usage-alert-state.json'),
      monitorEnabled: true,
      alertEnabled: true,
      checkIntervalSec: 3600,
      idleGateSec: 30,
      warnThreshold: 80,
      highThreshold: 90,
      criticalThreshold: 95,
      notifyCooldownSec: 14400,
      activeHoursStart: 8,
      activeHoursEnd: 23,
      getLocalHour: () => overrides.localHour ?? 10,
      runC4Control: (args) => {
        calls.control.push(args);
        return { ok: true, output: 'OK: enqueued control 1' };
      },
      log: (message) => calls.log.push(message),
    }
  );
  return { dir, monitor, calls };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('UsageMonitor', () => {
  it('preserves startup check timing semantics for Claude and Codex', () => {
    const claude = makeMonitor();
    assert.equal(claude.monitor.initializeLastCheckAt(5000), 5000);

    fs.writeFileSync(path.join(claude.dir, 'usage.json'), JSON.stringify({ lastCheckEpoch: 1234 }));
    assert.equal(claude.monitor.initializeLastCheckAt(5000), 1234);

    const codex = makeMonitor({ runtimeId: 'codex' });
    assert.equal(codex.monitor.initializeLastCheckAt(5000), 0);
  });

  it('refreshes local usage state without sending an alert', () => {
    const { dir, monitor, calls } = makeMonitor();
    fs.writeFileSync(path.join(dir, 'statusline.json'), JSON.stringify({
      usage: {
        session: { percent: 12, resets: 'soon' },
        weeklyAll: { percent: 45, resets: 'Monday' },
        weeklySonnet: { percent: 30, resets: 'Monday' },
        fiveHour: { percent: 20, resets: 'later' }
      }
    }));

    assert.equal(monitor.runMonitor({ currentTime: 1000 }), true);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
    assert.equal(state.lastCheckEpoch, 1000);
    assert.equal(state.session.percent, 12);
    assert.equal(state.weeklyAll.percent, 45);
    assert.equal(state.tier, 'ok');
    assert.equal(state.statusShape, 'statusline_usage');
    assert.deepEqual(calls.control, []);
  });

  it('sends usage alerts from persisted monitor state and writes alert state', () => {
    const { dir, monitor, calls } = makeMonitor();
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({
      session: { percent: 70, resets: 'soon' },
      weeklyAll: { percent: 96, resets: 'Monday' },
      weeklySonnet: { percent: 91, resets: 'Monday' },
      tier: 'critical'
    }));

    assert.equal(monitor.runAlert({ currentTime: 2000 }), true);

    assert.equal(calls.control.length, 1);
    assert.deepEqual(calls.control[0].slice(0, 2), ['enqueue', '--content']);
    assert.match(calls.control[0][2], /Usage Critical/);
    const alertState = JSON.parse(fs.readFileSync(path.join(dir, 'usage-alert-state.json'), 'utf8'));
    assert.equal(alertState.lastObservedTier, 'critical');
    assert.equal(alertState.lastNotifiedTier, 'critical');
    assert.equal(alertState.sourceRuntime, 'claude');
  });

  it('suppresses repeated alerts during cooldown', () => {
    const { dir, monitor, calls } = makeMonitor();
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({
      session: { percent: 70 },
      weeklyAll: { percent: 92 },
      tier: 'high'
    }));
    fs.writeFileSync(path.join(dir, 'usage-alert-state.json'), JSON.stringify({
      lastNotifiedTier: 'high',
      lastNotifiedAt: new Date(1000 * 1000).toISOString()
    }));

    assert.equal(monitor.runAlert({ currentTime: 2000 }), true);

    assert.deepEqual(calls.control, []);
    assert.ok(calls.log.some(message => message.includes('suppressing notification')));
  });
});
