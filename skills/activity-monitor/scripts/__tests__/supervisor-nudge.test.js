import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RestartRequestStore } from '../restart-request-store.js';
import { NO_RESPONSE_SILENCE_MS, NO_RESPONSE_GRACE_MS } from '../supervisor-health-observer.js';

// The real Escape/continue pair; the 500 ms gap it requests ends on the next event-loop turn.
const nudgeModule = new URL('../../../../cli/lib/session-nudge.js', import.meta.url).href;
const { nudgeSession } = await import(nudgeModule);
mock.module(nudgeModule, { namedExports: { nudgeSession: options => nudgeSession({ ...options, delay: async milliseconds => {
  assert.equal(milliseconds, 500);
  await new Promise(resolve => setImmediate(resolve));
} }) } });
const { createSupervisor } = await import('../supervisor.js');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Real composition, SessionActivity event reader, HealthStore and request store;
// only scene operations and the C4 database boundary are in-memory fixtures.
function fixture(t, { watchdog = false, runtime='claude', mode = 'multi', onControl = control => control } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-nudge-'));
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  let clock = 1792000000000, fence = null, transition = null;
  const scene = { runtime, sessionGroup: mode === 'single' ? 'origin' : 'telegram:a', runId: 'run-a', sessionId: 'session-a',
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
      return onControl(control);
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
    requestStore, readConfiguration: async () => ({ mode, runtime: 'claude', capacity: 3 }),
    readMode: () => ({ mode, keyPresent: true }),
    resolveTargetRuntime: async () => runtime,
    checkAuth: async () => ({ status: 'uncertain' }), matchScreen: async () => ({}),
    resolveToolRule: () => watchdog ? { watchdog: { enabled: true, maxRuntimeSec: 10, interruptGraceSec: 15, cooldownSec: 2 } } : null,
    log: error => errors.push(error),
    loopOptions: { schedule: () => 1, cancel: () => {} },
  });
  const health = supervisor.health.store(runtime), state = health.read();
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
    manual: () => requestStore.write([{ requestId: 'manual-test', reason: 'manual_restart', mode,
      ...(mode === 'single' ? {} : { sessionGroup: scene.sessionGroup }), expectedRunId: scene.runId, runIds: [scene.runId], acceptedAt: clock }]),
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

