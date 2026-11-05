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
  const rows = new Map(), records = [], sends = [], logs = [];
  const config = { session_mode: 'multi', runtime: 'claude', session_pool_size: 2,
    alert_target: 'telegram:fixture-owner', statusNotices };
  const db = {
    getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    getLastActivity: () => 0, getUnsummarizedRange: () => ({ count: 0, firstAt: null }),
    listSlotOccupancy: () => [], pruneSlots: () => ({ deletedHeld: 0, deletedOrphans: 0 }),
    listPendingSessionGroups: () => [], listPendingContinuations: () => [],
    listRunEndings: () => [...rows.values()], getLastCompletedModeTransition: () => null,
    getControlById: () => null, resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
    recordRunEnd: (group, value) => {
      const row = { sessionGroup: group, ...value, endedAt: Math.floor(time / 1000) };
      rows.set(group, row); records.push(row); return { recorded: true };
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
    readSyncMarker: () => ({ held: false, stale: false }),
    sendAlert: async (target, message) => { sends.push({ target, message }); return true; },
    log: value => logs.push(value), loopOptions: { schedule: () => 1, cancel() {} },
  });
  async function round() { await service.supervisor.loop.tick(); await flush(); }
  async function ended(group = 'test:a', duration = 1000) {
    const directory = path.join(zylos, 'activity-monitor', 'session-groups', group);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'current-session.json'), temporary = file + '.new';
    fs.writeFileSync(temporary, JSON.stringify({ runId: `run-${++sequence}`, ts: time - duration }));
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

// Integration boundary: actual entry configuration and common bilingual renderer.
// Run for repeated-failure override validation or alert wiring; skip other UI.
// All paths read back before private am.sock startup, injected DB/scenes/send;
// no live tmux/PM2/network. Test cleanup awaits service/socket stop before removal.
test('ready-run alerts use configured text and reject invalid localized overrides', async t => {
  const f = await fixture(t, { brand: 'Acme', templates: { repeated_failure: {
    ended_unexpectedly: { zh: '对话 {group} 已中断 {count} 次。', en: '\u0000invalid' },
  } } });
  for (let i = 0; i < 5; i++) await f.ended('test:custom');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].message,
    '[Acme] 对话 test:custom 已中断 5 次。\n' + expected('test:custom', 5, 'Acme').split('\n')[1]);
  f.config.statusNotices = { brand: 'Changed', templates: { repeated_failure: {
    ended_unexpectedly: { zh: '再次 {group}/{count}', en: 'again {group}/{count}' },
  } } };
  f.advance(1800000); await f.ended('test:custom');
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].message, '[Changed] 再次 test:custom/6\n[Changed] again test:custom/6');
});

// Integration boundary: actual reconciliation preserves >=10-minute and intentional
// reset behavior. Run for run-ending event changes; skip unrelated template/UI work.
// Private five-path environment/socket read back, DB/scenes/send injected; no
// tmux/PM2/network. All rounds bounded, listener/service stopped before cleanup.
test('ten-minute and intentional endings reset the existing short-run count', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.ended();
  await f.ended('test:a', 600000);
  for (let i = 0; i < 4; i++) await f.ended();
  assert.equal(f.sends.length, 0);
  await f.ended();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].message, expected('test:a', 5));
  const last = f.rows.get('test:a');
  f.rows.set('test:a', { ...last, reason: 'upgrade' });
  await f.round();
  f.advance(1_800_000);
  for (let i = 0; i < 4; i++) await f.ended();
  assert.equal(f.sends.length, 1);
  await f.ended();
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].message, expected('test:a', 5));
});

// Integration boundary: calls the actual alert dependency composed by the entry,
// preserving generic event text. Run for main alert branch changes; skip other UI.
// Private five-path environment/socket read back; external I/O is injected and
// service/socket closes before fixture removal, no live tmux/PM2/network.
test('other supervisor alerts retain their existing diagnostic wording', async t => {
  const f = await fixture(t);
  await f.service.supervisor.lifecycle.d.alert({ event: 'fixture_attention', session_group: 'test:a',
    requestId: 'request-1', reason: 'fixture_reason', count: 9 });
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].message, 'Supervisor: fixture_attention (test:a). requestId=request-1 reason=fixture_reason');
});
