import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { NO_RESPONSE_SILENCE_MS, NO_RESPONSE_GRACE_MS } from '../supervisor-health-observer.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Real composition, SessionActivity event reader, HealthStore and request store;
// only scene operations and the C4 database boundary are in-memory fixtures.
function fixture(t, { watchdog = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-nudge-'));
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  let clock = 1792000000000, fence = null, transition = null;
  const scene = { runtime: 'claude', sessionGroup: 'telegram:a', runId: 'run-a', sessionId: 'session-a',
    runDir, createdAt: clock, present: true, ready: true, processRunning: true };
  let current = { ...scene };
  const controls = [], stops = [], errors = [], firstControl = deferred(), cleanup = [];
  const requestStore = new RestartRequestStore({ file: path.join(root, 'requests.json') });
  const db = {
    getModeTransition: () => transition, getDrainFence: () => fence,
    listDrainFences: () => [], getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    listPendingSessionGroups: () => [], listPendingContinuations: () => [],
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
    insertControl(content, options) {
      const control = { id: controls.length + 1, content, ...options };
      controls.push(control);
      if (controls.length === 1) firstControl.resolve();
      return control;
    },
    getControlById: id => controls[id - 1],
  };
  const scenes = {
    observe: async () => [current], readIdentity: async () => current,
    observeGroup: async () => current, readRun: async () => current, listRuns: async () => [current],
    readScreen: async () => '', bindTarget: async value => ({ runtime: value.runtime, runId: value.runId, sessionId: value.sessionId }),
    stop: async value => { stops.push(value); },
  };
  const supervisor = createSupervisor({ db, scenes, zylosDir: root, env: { ZYLOS_DIR: root }, now: () => clock,
    requestStore, readConfiguration: async () => ({ mode: 'multi', runtime: 'claude', capacity: 3 }),
    readMode: () => ({ mode: 'multi' }), resolveTargetRuntime: async () => 'claude',
    checkAuth: async () => ({ status: 'uncertain' }), matchScreen: async () => ({}),
    resolveToolRule: () => watchdog ? { watchdog: { enabled: true, maxRuntimeSec: 10, interruptGraceSec: 15, cooldownSec: 2 } } : null,
    log: error => errors.push(error),
    loopOptions: { schedule: () => 1, cancel: () => {} },
  });
  const health = supervisor.health.store('claude'), state = health.read();
  state.health = 'ok'; health.write(state);
  const appendActivity = (event = 'prompt', fields = {}) => fs.appendFileSync(path.join(runDir, 'events.jsonl'),
    `${JSON.stringify({ v: 1, ts: clock, run_id: scene.runId, session_id: scene.sessionId, runtime: scene.runtime, event, ...fields })}\n`);
  const transcript = path.join(runDir, 'transcript.jsonl');
  fs.writeFileSync(transcript, ''); fs.utimesSync(transcript, clock / 1000, clock / 1000);
  appendActivity('session_start', { transcript_path: transcript });
  appendActivity();
  if (watchdog) appendActivity('pre_tool', { tool: 'WebFetch', tool_use_id: 'web-tool' });
  const delivered = () => supervisor.observer.notifyDelivered({ ...scene, pastedAt: clock });
  if (!watchdog) delivered();
  clock += NO_RESPONSE_SILENCE_MS;
  // Release fixture barriers before awaiting shutdown, including timeout teardown.
  t.after(async () => {
    for (const release of cleanup) release();
    await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { supervisor, scene, controls, stops, errors, firstControl, delivered, appendActivity,
    writeTranscript: row => {
      fs.appendFileSync(transcript, `${JSON.stringify(row)}\n`);
      fs.utimesSync(transcript, clock / 1000, clock / 1000);
    },
    onCleanup: release => cleanup.push(release),
    now: () => clock, advance: milliseconds => { clock += milliseconds; },
    fence: () => { fence = { reason: 'test' }; }, transition: () => { transition = { phase: 'draining' }; },
    replaceRun: () => { current = { ...current, runId: 'replacement' }; },
    replaceSession: () => { current = { ...current, sessionId: 'replacement-session' }; },
    manual: () => requestStore.write([{ requestId: 'manual-test', reason: 'manual_restart', mode: 'multi',
      sessionGroup: scene.sessionGroup, expectedRunId: scene.runId, runIds: [scene.runId], acceptedAt: clock }]),
    observe: () => supervisor.observer.observeScene(scene),
  };
}

test('composed no-response nudge enqueues bound Escape then exact continue and releases admission during delay', { timeout: 5000 }, async t => {
  const f = fixture(t);
  let completed = false;
  const observation = f.observe().then(() => { completed = true; });
  await f.firstControl.promise;
  await f.supervisor.admission.serialize(() => {
    assert.equal(completed, false, 'nudge completed before the inter-control delay');
    assert.equal(f.controls.length, 1, 'admission was held until continue');
  });
  await observation;
  assert.deepEqual(f.controls, ['[KEYSTROKE]Escape', 'continue'].map((content, index) => ({
    id: index + 1, content, sessionGroup: f.scene.sessionGroup,
    targetBinding: { runtime: 'claude', runId: 'run-a', sessionId: 'session-a' },
    priority: 0, bypassState: true, appendAckSuffix: false,
  })));
  assert.equal(f.stops.length, 0);
  assert.deepEqual(f.errors, []);
});

for (const gate of ['paste', 'fence', 'transition', 'run', 'session', 'manual', 'shutdown']) {
  test(`composed no-response nudge ${gate} change between controls suppresses continue`, { timeout: 5000 }, async t => {
    const f = fixture(t), observation = f.observe();
    await f.firstControl.promise;
    await f.supervisor.admission.serialize(() => {
      f.advance(1);
      if (gate === 'paste') f.delivered();
      if (gate === 'fence') f.fence();
      if (gate === 'transition') f.transition();
      if (gate === 'run') f.replaceRun();
      if (gate === 'session') f.replaceSession();
      if (gate === 'manual') f.manual();
      if (gate === 'shutdown') void f.supervisor.stop();
    });
    await observation;
    assert.deepEqual(f.controls.map(control => control.content), ['[KEYSTROKE]Escape']);
    assert.equal(f.stops.length, 0);
    assert.deepEqual(f.errors, []);
  });
}

test('composed no-response nudge continues after Escape produces Stop and transcript activity', { timeout: 5000 }, async t => {
  const f = fixture(t), observation = f.observe();
  await f.firstControl.promise;
  await f.supervisor.admission.serialize(() => {
    f.advance(1);
    f.appendActivity('stop');
    f.writeTranscript({ type: 'assistant', sessionId: f.scene.sessionId, timestamp: new Date(f.now()).toISOString() });
  });
  await observation;
  assert.deepEqual(f.controls.map(control => control.content), ['[KEYSTROKE]Escape', 'continue']);
  await f.observe();
  assert.ok(f.supervisor.observer.scenes.get(f.scene.sessionGroup).delivery,
    'Escape Stop cannot complete the resumed conversation before it starts');
  assert.equal(f.stops.length, 0);
  assert.deepEqual(f.errors, []);
});

test('composed web watchdog nudge continues after Escape removes the timed-out tool', { timeout: 5000 }, async t => {
  const f = fixture(t, { watchdog: true }), observation = f.observe();
  await f.firstControl.promise;
  await f.supervisor.admission.serialize(() => {
    f.advance(1);
    f.appendActivity('post_tool', { tool: 'WebFetch', tool_use_id: 'web-tool' });
    f.appendActivity('stop');
  });
  await observation;
  assert.equal(f.supervisor.readActivity(f.scene).tools.length, 0);
  assert.deepEqual(f.controls.map(control => control.content), ['[KEYSTROKE]Escape', 'continue']);
  assert.equal(f.stops.length, 0);
  assert.deepEqual(f.errors, []);
});

test('composed no-response recovery stops the same silent run after nudge grace expires', { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.observe();
  f.advance(NO_RESPONSE_GRACE_MS);
  await f.observe();
  assert.equal(f.stops.length, 1, 'unchanged silence must reach the real composed stop');
  assert.equal(f.stops[0].runId, f.scene.runId);
  assert.equal(f.controls.length, 2);
  assert.deepEqual(f.errors, []);
});

test('composed no-response guarded stop rechecks activity that arrived while waiting for admission', { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.observe();
  assert.equal(f.controls.length, 2);
  f.advance(NO_RESPONSE_GRACE_MS);
  const blocked = deferred(), release = deferred(), stopQueued = deferred();
  f.onCleanup(release.resolve);
  t.signal.addEventListener('abort', release.resolve, { once: true });
  const serialize = f.supervisor.admission.serialize.bind(f.supervisor.admission);
  const blocker = serialize(async () => { blocked.resolve(); await release.promise; });
  try {
    await blocked.promise;
    f.supervisor.admission.serialize = operation => { stopQueued.resolve(); return serialize(operation); };
    const stopping = f.observe();
    await stopQueued.promise;
    f.advance(1); f.appendActivity();
    release.resolve();
    await Promise.all([blocker, stopping]);
  } finally {
    release.resolve();
  }
  assert.equal(f.stops.length, 0, 'fresh activity must cancel the stale stop');
  assert.equal(f.controls.length, 2);
  assert.deepEqual(f.errors, []);
});
