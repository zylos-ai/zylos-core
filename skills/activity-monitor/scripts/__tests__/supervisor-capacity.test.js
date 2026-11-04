import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSupervisor } from '../supervisor-main.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { mode = 'multi', readMemory } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-entry-'));
  let config = { session_mode: mode, runtime: 'claude', session_pool_size: 7 }, time = 1000000;
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), ZYLOS_SESSION_POOL_SIZE: '' };
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify(config));
  assert.notEqual(root, process.env.ZYLOS_DIR);
  let reads = 0, observations = 0;
  const memory = readMemory ?? (async () => ({ source: 'host', limitBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3 }));
  const service = await startSupervisor({ env, now: () => time,
    readMode: () => ({ mode: config.session_mode, keyPresent: true }), readConfig: () => config,
    readMemoryInputs: () => { reads++; return memory(); },
    db: { getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
      listPendingSessionGroups: () => [], getControlById: () => null,
      resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }) },
    scenes: { observe: async () => { observations++; return []; },
      readIdentity: async () => ({ present: false }), observeGroup: async () => ({ present: false }),
      listRuns: async () => [], readRun: async () => null },
    legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
    sendAlert: () => { throw new Error('External sends are forbidden in this fixture'); }, log: () => {},
    loopOptions: { schedule: () => 1, cancel: () => {} } });
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const round = async () => { await service.supervisor.loop.tick(); await flush(); };
  return { root, service, round, reads: () => reads, observations: () => observations,
    setMode: value => { config = { ...config, session_mode: value }; },
    setFixed: value => { config = { ...config, session_pool_size: value }; },
    advance: ms => { time += ms; },
    record: () => JSON.parse(fs.readFileSync(path.join(root, 'activity-monitor', 'pool-capacity.json'), 'utf8')) };
}

// Integration boundary: actual supervisor entry, capacity controller and Core
// reader share published K. Run for capacity wiring/metrics changes; skip other
// lifecycle work. Fresh HOME/ZYLOS_DIR/PM2_HOME and runner short TMPDIR; only
// private am.sock, fake scenes and injected memory, no tmux/database/network.
test('entry publishes fixed capacity and uses it in metrics without resampling each round', async t => {
  const f = await fixture(t); await flush(); await f.round();
  assert.equal(f.record().k, 7);
  assert.equal(f.record().source, 'fixed');
  assert.equal(f.service.supervisor.loop.configuration.capacity, 7);
  assert.equal(f.reads(), 1);
  f.setFixed(4); f.advance(10000); await f.round(); await f.round();
  assert.equal(f.record().k, 4);
  assert.equal(f.service.supervisor.loop.configuration.capacity, 4);
  const metrics = fs.readFileSync(path.join(f.root, 'activity-monitor', 'pool-metrics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(metrics.some(row => row.v === 1 && row.k === 7 && row.kSource === 'fixed'));
  assert.ok(metrics.some(row => row.v === 1 && row.k === 4 && row.kSource === 'fixed'));
});

// Same isolated entry boundary; run for mode gating or capacity scheduling.
test('single mode never reads memory or writes capacity files', async t => {
  const f = await fixture(t, { mode: 'single' }); await f.round();
  assert.equal(f.reads(), 0);
  for (const name of ['pool-capacity.json', 'pool-memory-samples.jsonl']) {
    assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor', name)), false);
  }
});

// Same isolated entry boundary; run for async command or mode-switch changes.
// The held read stands for the bounded macOS command, not a real subprocess.
test('pending memory read does not block later rounds and single cutover suppresses late publication', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release(null));
  const f = await fixture(t, { readMemory: () => held });
  const before = f.observations();
  await f.round(); await f.round();
  assert.equal(f.reads(), 1);
  assert.ok(f.observations() >= before + 2);
  f.setMode('single'); await f.round();
  release({ source: 'host', limitBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3 });
  await flush(); await flush();
  assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor', 'pool-capacity.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor', 'pool-memory-samples.jsonl')), false);
});
