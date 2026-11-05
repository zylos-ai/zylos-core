import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSupervisor } from '../supervisor-main.js';
import * as poolReader from '../../../../cli/lib/session-pool-config.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { mode = 'multi', fixed = 7, readMemory, configPatch = {}, sendAlert, initialScenes = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-entry-'));
  let config = { session_mode: mode, runtime: 'claude', session_pool_size: fixed, ...configPatch }, time = 1000000;
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), ZYLOS_SESSION_POOL_SIZE: '' };
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify(config));
  assert.notEqual(root, process.env.ZYLOS_DIR);
  let reads = 0, observations = 0, configError = false;
  const currentScenes = initialScenes, fences = new Map(), sends = [];
  const diagnostics = () => {
    const file = path.join(root, 'activity-monitor', 'supervisor-events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  const logs = [];
  const memory = readMemory ?? (async () => ({ source: 'host', limitBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3 }));
  const service = await startSupervisor({ env, now: () => time,
    readMode: () => ({ mode: config.session_mode, keyPresent: true }), readConfig: () => { if (configError) throw Object.assign(new Error('private configuration unreadable'), { code: 'CONFIG_UNREADABLE' }); return config; },
    readMemoryInputs: () => { reads++; return memory(); },
    db: { getModeTransition: () => null, listDrainFences: () => [...fences.values()], getDrainFence: group => fences.get(group),
      setDrainFence: (group, row) => fences.set(group, { ...row, sessionGroup: group }),
      getLastActivity: () => 0, getUnsummarizedRange: () => ({ count: 0, firstAt: null }),
      listPendingSessionGroups: () => [], listPendingContinuations: () => [], listRunEndings: () => [],
      getLastCompletedModeTransition: () => null, getControlById: () => null,
      resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }) },
    scenes: { observe: async () => { observations++; return currentScenes.map(scene => ({ ...scene })); },
      readIdentity: async () => ({ present: false }), observeGroup: async group => currentScenes.find(scene => scene.sessionGroup === group) ?? { present: false },
      listRuns: async () => [], readRun: async () => null },
    legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
    readSyncMarker: () => ({ held: false, stale: false }),
    sendAlert: async (target, message) => { sends.push({ target, message }); return sendAlert ? sendAlert(target, message) : true; }, log: event => logs.push(event),
    loopOptions: { schedule: () => 1, cancel: () => {} } });
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const round = async () => { await service.supervisor.loop.tick(); await flush(); };
  return { root, service, round, logs, sends, fences, currentScenes, diagnostics, setConfigError: value => { configError = value; }, reads: () => reads, observations: () => observations,
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
  f.setFixed(4); f.advance(10000); await f.round();
  assert.equal(f.record().k, 4);
  assert.equal(f.service.supervisor.loop.configuration.capacity, 7);
  await f.round();
  assert.equal(f.service.supervisor.loop.configuration.capacity, 4);
  const metrics = fs.readFileSync(path.join(f.root, 'activity-monitor', 'pool-metrics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(metrics.some(row => row.v === 1 && row.k === 7 && row.kSource === 'fixed'));
  assert.ok(metrics.some(row => row.v === 1 && row.k === 4 && row.kSource === 'fixed'));
});

// Integration boundary: actual entry mode gate and capacity file absence.
// Run for mode gating/capacity scheduling; skip unrelated lifecycle changes.
// Fresh HOME/ZYLOS_DIR/PM2_HOME and runner short TMPDIR; private am.sock,
// injected scenes/database adapter/memory, no tmux, live database or network.
// Service/socket are stopped before removing only this fixture's files.
test('single mode never reads memory or writes capacity files', async t => {
  const f = await fixture(t, { mode: 'single' }); await f.round();
  assert.equal(f.reads(), 0);
  for (const name of ['pool-capacity.json', 'pool-memory-samples.jsonl']) {
    assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor', name)), false);
  }
});

// Integration boundary: actual entry startup/rounds and pending memory work.
// Run for async memory commands or mode cutover; skip unrelated lifecycle changes.
// Fresh HOME/ZYLOS_DIR/PM2_HOME and runner short TMPDIR; private am.sock,
// injected scenes/database adapter/memory, no tmux, live database or network.
// Release held reads and stop the service/socket before fixture cleanup.
test('pending memory read does not block later rounds and single cutover suppresses late publication', { timeout: 2000 }, async t => {
  let release, started = false;
  const held = new Promise(resolve => { release = resolve; });
  const creating = fixture(t, { readMemory: () => { started = true; return held; } });
  let ready = false;
  creating.then(() => { ready = true; });
  try {
    for (let i = 0; i < 100 && !ready; i++) await flush();
    assert.equal(started, true);
    assert.equal(ready, true, 'entry startup must settle while the memory read is pending');
    const f = await creating, before = f.observations();
    for (let i = 0; i < 2; i++) {
      let settled = false;
      const round = f.round().then(() => { settled = true; });
      for (let spin = 0; spin < 100 && !settled; spin++) await flush();
      assert.equal(settled, true, 'lifecycle round must settle before the memory read');
      await round;
    }
    assert.equal(f.reads(), 1);
    assert.ok(f.observations() >= before + 2);
    f.setMode('single'); await f.round();
    release({ source: 'host', limitBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3 });
    await flush(); await flush();
    assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor', 'pool-capacity.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor', 'pool-memory-samples.jsonl')), false);
  } finally {
    release(null);
    await creating;
  }
});

for (const fixed of [false, true]) {
  // Integration boundary: actual entry/controller/atomic rename/shared reader,
  // including stale last-successful publication and current fixed precedence.
  // Run for publication, freshness or baseline wiring; skip unrelated lifecycle.
  // Fresh HOME/ZYLOS_DIR/PM2_HOME and runner short TMPDIR; private am.sock,
  // injected scenes/database adapter/memory, no tmux, live database or network.
  // Only the platform/total-memory input to the real baseline is substituted.
  // Stop service/socket before cleaning the fixture, including failed temp writes.
  test(`entry expires its last successful publication after write failures (${fixed ? 'fixed' : 'automatic'})`, async t => {
    t.mock.module(new URL('../../../../cli/lib/session-pool-config.js', import.meta.url).href, {
      namedExports: { ...poolReader, resolveSessionPoolBaseline: options =>
        poolReader.resolveSessionPoolBaseline({ ...options, platform: 'darwin', totalMemoryBytes: 4 * 1024 ** 3 }) },
    });
    const f = await fixture(t, { fixed: fixed ? 6 : null,
      readMemory: async () => ({ source: 'host', limitBytes: 4 * 1024 ** 3, usedBytes: 1300 * 1024 ** 2 }) });
    await flush();
    if (!fixed) {
      assert.equal(f.record().k, 2);
      for (let i = 0; i < 12; i++) { f.advance(10000); await f.round(); }
      assert.equal(f.record().k, 3);
      assert.equal(f.service.supervisor.loop.configuration.capacity, 2);
      await f.round();
    }
    const published = f.record();
    assert.equal(published.k, fixed ? 6 : 3);
    assert.equal(f.service.supervisor.loop.configuration.capacity, published.k);
    const file = path.join(f.root, 'activity-monitor', 'pool-capacity.json');
    fs.renameSync(file, file + '.saved');
    fs.mkdirSync(file); // Actual atomic rename fails against this private directory.
    if (fixed) f.setFixed(4);
    f.advance(61000); await f.round();
    assert.ok(f.diagnostics().some(event => event.event === 'capacity_publish_failed'));
    assert.equal(f.service.supervisor.loop.configuration.capacity, fixed ? 4 : 2);
    assert.equal(f.service.supervisor.loop.configuration.capacitySource, fixed ? 'fixed' : 'fallback');
    assert.deepEqual(JSON.parse(fs.readFileSync(file + '.saved', 'utf8')), published);
    assert.equal(fs.statSync(file).isDirectory(), true);
  });
}

for (const route of ['target', 'missing', 'failed']) {
  // Integration boundary: actual entry -> capacity memory warning -> renderer ->
  // unchanged guard.notify routing -> injected sender and real F12 diagnostic.
  // Run for notice/entry wiring; skip unrelated lifecycle. Runner provides fresh
  // HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR; private am.sock and fixture
  // DB/scenes only, no tmux/PM2/network. Service closes before fixture cleanup.
  test(`capacity notices use the configured destination and Web Console fallback (${route})`, async t => {

    const f = await fixture(t, { configPatch: route === 'missing' ? {} : { alert_target: 'telegram:fixture-owner' },
      readMemory: async () => ({ source: 'cgroup2', limitBytes: 4 * 1024 ** 3, usedBytes: 3900 * 1024 ** 2 }),
      sendAlert: target => route === 'failed' && target.channel === 'telegram' ? false : true });
    await flush(); f.advance(10000); await f.round(); await flush();
    const last = f.sends.at(-1);
    assert.equal(last.target.channel, route === 'target' ? 'telegram' : 'web-console');
    assert.equal(f.sends.length, route === 'failed' ? 2 : 1);
    assert.equal(last.message.split('\n').length, 2);
    assert.match(last.message, /^\[Zylos\] 这台机器内存快用完了/);
    assert.doesNotMatch(last.message, /cgroup|oom|fixture-owner|1073741824/i);
    assert.equal(f.diagnostics().some(row => row.event === 'container_oom_kill'), false);
  });
}

// Integration boundary: actual readConfiguration failure and already-observed
// input failure timer, renderer default config and guard sender.
// Run when F1 failure/notice scheduling changes; skip unrelated lifecycle.
// Fresh runner HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR; private am.sock,
// fixture DB and injected memory/scenes, no tmux/PM2/network. Lifecycle stop and
// file cleanup run even on assertion failure; no detached background work.
test('unreadable configuration sends delayed default notices without stale calculations or reclaim', async t => {
  const f = await fixture(t, { fixed: null, readMemory: async () => null,
    configPatch: { statusNotices: { brand: 'FixtureBrand' } } });
  await flush();
  const file = path.join(f.root, 'activity-monitor', 'pool-capacity.json');
  fs.renameSync(file, file + '.saved'); fs.mkdirSync(file);
  f.advance(10000); await f.round();
  const before = f.reads(), observations = f.observations();
  f.setConfigError(true); f.advance(59000); await f.round(); await flush();
  assert.equal(f.sends.length, 1, 'only the earlier input failure has reached sixty seconds');
  assert.match(f.sends[0].message, /^\[Zylos\] 系统出现异常/);
  f.advance(1000); await f.round(); await flush();
  assert.equal(f.sends.length, 1);
  assert.equal(f.reads(), before); assert.equal(f.observations(), observations);
  assert.equal(f.fences.size, 0);
  assert.equal(fs.statSync(file).isDirectory(), true);
  f.advance(60000); await f.round(); await flush(); assert.equal(f.sends.length, 1);
});

// Integration boundary: real pressure candidate -> beginReclaim -> F12 and
// guard.notify, with effective startup eviction threshold. Run for pressure
// wiring/idle duration changes; skip other lifecycle work. All five runner
// paths isolated; private am.sock, in-memory DB/scenes, no tmux/PM2/network.
// No process is stopped; only the real beginReclaim fence is observed.
test('entry pressure writes its selected group only to diagnostics', async t => {
  const group = { sessionGroup: 'private-group', present: true, ready: true, state: 'idle',
    runId: 'private-run', sessionId: 'session', createdAt: 0, idleSince: 0, processRunning: false };
  const f = await fixture(t, { fixed: null, initialScenes: [group], configPatch: { session_evict_min_idle_seconds: 659 },
    readMemory: async () => ({ source: 'host', limitBytes: 4 * 1024 ** 3, usedBytes: 3900 * 1024 ** 2 }) });
  await flush(); f.advance(10000); await f.round(); await flush();
  assert.equal(f.fences.get(group.sessionGroup)?.reason, 'evict');
  const notice = f.sends.find(row => row.message.includes('这台机器内存快用完了'));
  assert.ok(notice); assert.match(notice.message, /things may slow down or become unstable/);
  assert.doesNotMatch(notice.message, /private-group|private-run|4089446400/);
  const event = f.diagnostics().find(row => row.event === 'capacity_pressure_evict');
  assert.equal(event?.session_group, group.sessionGroup); assert.equal(event?.k, 1);
});

for (const change of ['single', 'fixed', 'stop']) {
  // Integration boundary: actual capacity async read -> existing admission queue
  // -> fresh mode/fixed/stopping guard before pressure fencing. Run when this
  // queue/guard changes; skip other lifecycle work. Fresh runner HOME/ZYLOS_DIR/
  // PM2_HOME/short TMPDIR/TMUX_TMPDIR; private am.sock and fixture DB/scenes only,
  // no tmux/PM2/network. Both held promises are released in finally, stop awaited.
  test(`queued pressure work is cancelled by a fresh ${change} boundary`, { timeout: 2000 }, async t => {
    let releaseMemory, releaseQueue, memoryReads = 0;
    const heldMemory = new Promise(resolve => { releaseMemory = resolve; });
    const heldQueue = new Promise(resolve => { releaseQueue = resolve; });
    const memory = { source: 'host', limitBytes: 4 * 1024 ** 3, usedBytes: 3900 * 1024 ** 2 };
    const group = { sessionGroup: 'private-group', present: true, ready: true, state: 'idle', runId: 'run', sessionId: 'session',
      createdAt: 0, idleSince: 0, processRunning: false };
    const f = await fixture(t, { fixed: null, initialScenes: [group],
      readMemory: () => ++memoryReads === 1 ? Promise.resolve(memory) : heldMemory });
    let stopping;
    try {
      await flush(); f.advance(10000); await f.round();
      const blocker = f.service.supervisor.admission.serialize(() => heldQueue);
      await flush(); releaseMemory(memory); await flush();
      if (change === 'single') f.setMode('single');
      if (change === 'fixed') f.setFixed(3);
      if (change === 'stop') stopping = f.service.stop();
      releaseQueue(); await blocker; await flush(); await flush(); await stopping;
      assert.equal(f.fences.size, 0); assert.equal(f.sends.length, 1, 'memory warning does not depend on queued reclaim completion');
      assert.equal(f.diagnostics().some(row => row.event === 'capacity_pressure_evict'), false);
    } finally {
      releaseMemory(null); releaseQueue(); await stopping;
    }
  });
}

// Integration boundary: entry stop drains a real pending capacity calculation.
// Run for stop/capacityWork changes; skip unrelated work. All five runner paths
// isolated, private am.sock/injected DB/scenes, no tmux/PM2/network. Release the
// held read in finally, await stop before fixture cleanup; bounded test timeout.
test('stop waits for the pending capacity computation to finish', { timeout: 2000 }, async t => {
  let release, started = false;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { readMemory: () => { started = true; return held; } });
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  try {
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(started, true); assert.equal(stopped, false);
  } finally { release(null); await stopping; }
  assert.equal(stopped, true);
});

// Integration boundary: effective parsed idle threshold reaches pressure reclaim.
// Run for lifecycle configuration or pressure wiring; skip unrelated work. Fresh
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR, private am.sock and injected
// DB/scenes. No tmux/PM2/network or process stop; service closes before cleanup.
test('entry pressure honors a configured minimum idle duration longer than the candidate age', async t => {
  const group = { sessionGroup: 'private-group', present: true, ready: true, state: 'idle',
    runId: 'private-run', sessionId: 'session', createdAt: 0, idleSince: 0, processRunning: false };
  const f = await fixture(t, { fixed: null, initialScenes: [group], configPatch: { session_evict_min_idle_seconds: 3000 },
    readMemory: async () => ({ source: 'host', limitBytes: 4 * 1024 ** 3, usedBytes: 3900 * 1024 ** 2 }) });
  await flush(); f.advance(10000); await f.round(); await flush();
  assert.equal(f.fences.size, 0); assert.equal(f.sends.length, 1);
});
