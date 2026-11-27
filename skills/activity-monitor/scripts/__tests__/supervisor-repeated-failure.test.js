import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSupervisor } from '../supervisor-main.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const expected = (group, count, brand = 'Zylos') =>
  `[${brand}] 对话「${group}」连续 ${count} 次启动后不到 10 分钟就意外结束。系统会继续重起；如果一直这样，请检查这个对话正在做的任务或运行环境。\n` +
  `[${brand}] Conversation "${group}" ended unexpectedly ${count} times in a row, each within 10 minutes of starting. It keeps restarting. If this continues, check the task it is working on or its runtime environment.`;

async function fixture(t, statusNotices) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-'));
  const home = path.join(root, 'h'), zylos = path.join(home, 'z');
  const tmp = path.join(root, 't');
  fs.mkdirSync(zylos, { recursive: true }); fs.mkdirSync(tmp);
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, 'p'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, ZYLOS_SESSION_POOL_SIZE: '' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(env[key].startsWith(root + path.sep));
    assert.notEqual(env[key], process.env[key]);
  }
  const socket = path.join(zylos, 'activity-monitor', 'am.sock');
  assert.ok(Buffer.byteLength(socket) < 104);
  assert.ok(env.PM2_HOME.startsWith(home + path.sep));
  t.diagnostic(JSON.stringify({ repeatedFailureFixture: root, paths: Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, env[key]])), socket }));
  let time = 2_000_000, sequence = 0, service;
  const rows = new Map(), slots = new Map(), records = [], sends = [], logs = [];
  const config = { session_mode: 'multi', runtime: 'claude', session_pool_size: 2,
    alert_target: 'telegram:fixture-owner', statusNotices };
  const db = {
    getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    getLastActivity: () => 0, getUnsummarizedRange: () => ({ count: 0, firstAt: null }),
    listSlotOccupancy: () => [...slots.values()], pruneSlots: () => ({ deletedHeld: [], deletedOrphans: [] }),
    listPendingSessionGroups: () => [], listPendingContinuations: () => [],
    listRunEndings: groups => [...rows.values()].filter(row => groups.includes(row.sessionGroup)), getLastCompletedModeTransition: () => null,
    getControlById: () => null, resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
    recordRunEnd: (group, value) => {
      const row = { sessionGroup: group, ...value, endedAt: Math.floor(time / 1000) };
      rows.set(group, row); slots.delete(group); records.push(row); return { recorded: true };
    },
  };
  t.after(async () => {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  service = await startSupervisor({ env, now: () => time, db,
    readMode: () => ({ mode: 'multi', keyPresent: true }), readConfig: () => config,
    readMemoryInputs: async () => ({ source: 'host', limitBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3 }),
    scenes: { observe: async () => [], readIdentity: async () => ({ present: false }),
      observeGroup: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null },
    legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },

    sendAlert: async (target, message) => { sends.push({ target, message }); return true; },
    log: value => logs.push(value), loopOptions: { schedule: () => 1, cancel() {} },
  });
  async function round() { await service.supervisor.loop.tick(); await flush(); }
  async function ended(group = 'test:a', duration = 1000) {
    const directory = path.join(zylos, 'activity-monitor', 'session-groups', group);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'current-session.json'), temporary = file + '.new';
    const runId = `run-${++sequence}`;
    slots.set(group, { sessionGroup: group, runId, state: 'running' });
    fs.writeFileSync(temporary, JSON.stringify({ runId, ts: time - duration }));
    fs.renameSync(temporary, file);
    await round();
  }
  return { service, sends, logs, records, rows, round, ended, config, advance: ms => { time += ms; } };
}

// Integration boundary: real entry, run-ending reconciliation and alert rendering.
// Run for repeated-failure counting/template/entry changes; skip unrelated UI.
// Before startup read back private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and socket;
// DB/scenes/sender/memory are injected, no tmux/PM2/network. Stop service then clean.
test('ready runs alert on the fifth ending and retain per-group thirty-minute windows', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.ended();
  assert.equal(f.sends.length, 0);
  await f.ended();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].message, expected('test:a', 5));
  assert.deepEqual(f.sends[0].target, { channel: 'telegram', endpoint: 'fixture-owner' });
  await f.ended(); assert.equal(f.sends.length, 1);
  f.advance(1_799_000); await f.ended(); assert.equal(f.sends.length, 1);
  f.advance(1000); await f.ended();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].message, expected('test:a', 8));
  for (let i = 0; i < 5; i++) await f.ended('test:b');
  assert.equal(f.sends.length, 3);
  assert.equal(f.sends[2].message, expected('test:b', 5));
  assert.equal(f.records.length, 13);
});

