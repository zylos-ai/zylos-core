import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { NO_RESPONSE_SILENCE_MS, NO_RESPONSE_GRACE_MS, NO_RESPONSE_RETRY_MS } from '../supervisor-health-observer.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Real composition, SessionActivity event reader, HealthStore and request store;
// only scene operations and the C4 database boundary are in-memory fixtures.
function fixture(t, { watchdog = false, runtime='claude', onControl = control => control } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-nudge-'));
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  let clock = 1792000000000, fence = null, transition = null;
  const scene = { runtime, sessionGroup: 'telegram:a', runId: 'run-a', sessionId: 'session-a',
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
    requestStore, readConfiguration: async () => ({ mode: 'multi', runtime: 'claude', capacity: 3 }),
    readMode: () => ({ mode: 'multi' }), resolveTargetRuntime: async () => runtime,
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

test('new paste carries the pending pair without starting another watchdog and owns its retry', { timeout: 5000 }, async t => {
  const f = fixture(t, { watchdog: true });
  // Make delivery silence, rather than the web watchdog, own the first pair.
  f.supervisor.observer.notifyDelivered({ ...f.scene, pastedAt: f.now() - NO_RESPONSE_SILENCE_MS });
  const observation = f.observe();
  await f.firstControl.promise;
  const original = f.supervisor.observer.sceneState(f.scene).delivery;
  const episode = original.recovery;
  assert.equal(episode.pending, true);
  f.advance(1); f.delivered();
  const replacement = f.supervisor.observer.sceneState(f.scene).delivery;
  assert.notEqual(replacement, original);
  assert.equal(replacement.recovery, episode);
  await f.observe();
  assert.equal(f.controls.length, 1, 'the pending pair must exclude a second recovery or web watchdog');
  await observation;
  assert.deepEqual(f.controls.map(control => control.content), ['[KEYSTROKE]Escape']);
  assert.equal(replacement.recovery, null, 'a superseded continue must release the latest delivery');
  assert.equal(replacement.retryAt, f.now() + NO_RESPONSE_RETRY_MS);
  f.advance(NO_RESPONSE_RETRY_MS - 1); await f.observe();
  assert.equal(f.controls.length, 1);
  f.advance(1); await f.observe();
  assert.deepEqual(f.controls.map(control => control.content), ['[KEYSTROKE]Escape', '[KEYSTROKE]Escape', 'continue']);
  assert.equal(f.stops.length, 0);
  assert.deepEqual(f.errors, []);
});

test('new paste after continue insertion retains pending ownership and the original grace deadline', { timeout: 5000 }, async t => {
  const inserted = deferred(), release = deferred();
  const f = fixture(t, { onControl: control => {
    if (control.content !== 'continue') return control;
    inserted.resolve();
    return release.promise.then(() => control);
  } });
  f.onCleanup(release.resolve);
  const observation = f.observe();
  await inserted.promise;
  const original = f.supervisor.observer.sceneState(f.scene).delivery;
  const episode = original.recovery, acceptedAt = f.now();
  f.advance(1); f.delivered();
  const replacement = f.supervisor.observer.sceneState(f.scene).delivery;
  await f.observe();
  assert.equal(f.controls.length, 2, 'a pending inserted continue must retain exclusive recovery ownership');
  release.resolve(); await observation;
  assert.equal(replacement.recovery, episode);
  assert.equal(episode.pending, false);
  assert.equal(episode.nudgedAt, acceptedAt);
  f.advance(NO_RESPONSE_GRACE_MS - 2); await f.observe();
  assert.equal(f.stops.length, 0);
  f.advance(1); await f.observe();
  assert.equal(f.stops.length, 1, 'a newer paste must not extend the already accepted continue grace');
  assert.equal(f.supervisor.observer.sceneState(f.scene).delivery, null);
  assert.equal(f.controls.length, 2);
  assert.deepEqual(f.errors, []);
});

test('previous-turn assistant work after the latest paste disarms carried recovery without Stop', { timeout: 5000 }, async t => {
  const inserted = deferred(), release = deferred();
  const f = fixture(t, { onControl: control => {
    if (control.content !== 'continue') return control;
    inserted.resolve();
    return release.promise.then(() => control);
  } });
  f.onCleanup(release.resolve);
  const observation = f.observe();
  await inserted.promise;
  f.writeTranscript({ type: 'user', sessionId: f.scene.sessionId, isSidechain: false,
    timestamp: new Date(f.now()).toISOString(), message: { role: 'user', content: 'continue' } });
  f.advance(1); f.delivered();
  release.resolve(); await observation;
  f.advance(1);
  f.writeTranscript({ type: 'assistant', sessionId: f.scene.sessionId, isSidechain: false,
    timestamp: new Date(f.now()).toISOString(),
    message: { role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'Still working on the older task.' }] } });
  await f.observe();
  assert.equal(f.supervisor.observer.sceneState(f.scene).delivery.noResponseEligible, false,
    'any AI work after paste disarms delivery, even while the newest request is queued');
  f.advance(NO_RESPONSE_SILENCE_MS + NO_RESPONSE_GRACE_MS); await f.observe();
  assert.equal(f.controls.length, 2);
  assert.equal(f.stops.length, 0);
  assert.deepEqual(f.errors, []);
});

test('composed no-response nudge continues after Escape produces Stop and transcript activity', { timeout: 5000 }, async t => {
  const f = fixture(t), observation = f.observe();
  await f.firstControl.promise;
  await f.supervisor.admission.serialize(() => {
    f.advance(1);
    f.appendActivity('stop');
    f.writeTranscript({ type: 'user', isSidechain:false, sessionId: f.scene.sessionId, timestamp: new Date(f.now()).toISOString(), message:{role:'user',content:[{type:'text',text:'[Request interrupted by user]'}]} });
  });
  await observation;
  assert.deepEqual(f.controls.map(control => control.content), ['[KEYSTROKE]Escape', 'continue']);
  await f.observe();
  assert.ok(f.supervisor.observer.scenes.get(f.scene.sessionGroup).delivery,
    'Escape Stop is an input effect and must not disarm delivery');
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
    f.advance(1); f.appendActivity('pre_tool',{tool:'Read',tool_use_id:'resumed-work'});
    release.resolve();
    await Promise.all([blocker, stopping]);
  } finally {
    release.resolve();
  }
  assert.equal(f.stops.length, 0, 'fresh activity must cancel the stale stop');
  assert.equal(f.controls.length, 2);
  assert.deepEqual(f.errors, []);
});

test('composed no-response recovery restarts despite Escape interruption and continue prompt side effects', {timeout:5000},async t=>{
  const f=fixture(t),observation=f.observe();await f.firstControl.promise;
  f.advance(1);f.appendActivity('stop');
  f.writeTranscript({type:'user',isSidechain:false,sessionId:f.scene.sessionId,timestamp:new Date(f.now()).toISOString(),
    message:{role:'user',content:[{type:'text',text:'[Request interrupted by user for tool use]'}]}});
  await observation;const acceptedAt=f.now();f.advance(1);f.appendActivity('prompt');
  f.writeTranscript({type:'user',isSidechain:false,sessionId:f.scene.sessionId,timestamp:new Date(f.now()).toISOString(),message:{role:'user',content:'continue'}});
  await f.observe();assert.ok(f.supervisor.observer.sceneState(f.scene).delivery?.recovery);
  f.advance(NO_RESPONSE_GRACE_MS-2);await f.observe();assert.equal(f.stops.length,0);
  f.advance(1);await f.observe();assert.equal(f.now()-acceptedAt,NO_RESPONSE_GRACE_MS);assert.equal(f.stops.length,1);
  assert.equal(f.controls.length,2);assert.deepEqual(f.errors,[]);
});
for(const response of ['tool','assistant','child-tool'])test(`composed ${response} work cancels no-response recovery`,{timeout:5000},async t=>{
  const f=fixture(t);await f.observe();f.advance(1);
  if(response==='assistant')f.writeTranscript({type:'assistant',isSidechain:false,sessionId:f.scene.sessionId,
    timestamp:new Date(f.now()).toISOString(),message:{role:'assistant',model:'claude-fixture',content:[{type:'text',text:'Work resumed.'}]}});
  else f.appendActivity('pre_tool',{tool:'Read',tool_use_id:'resumed-work',...(response==='child-tool'?{agent_id:'worker'}:{})});
  await f.observe();assert.equal(f.supervisor.observer.sceneState(f.scene).delivery.noResponseEligible,false);
  f.advance(NO_RESPONSE_SILENCE_MS + NO_RESPONSE_GRACE_MS);await f.observe();assert.equal(f.stops.length,0);assert.equal(f.controls.length,2);
});
test('composed Claude prompt, queue records and Stop cannot disarm a silent paste',{timeout:5000},async t=>{
  const f=fixture(t);f.advance(-899700);f.delivered();f.advance(1);f.appendActivity('prompt');
  f.writeTranscript({type:'queue-operation',operation:'enqueue',timestamp:new Date(f.now()).toISOString(),sessionId:f.scene.sessionId});
  f.advance(99);f.appendActivity('stop');await f.observe();
  assert.ok(f.supervisor.observer.sceneState(f.scene).delivery,'queue and prompt records are input effects');
  f.advance(1);f.writeTranscript({type:'queue-operation',operation:'dequeue',timestamp:new Date(f.now()).toISOString(),sessionId:f.scene.sessionId});
  await f.observe();assert.ok(f.supervisor.observer.sceneState(f.scene).delivery);
  f.advance(NO_RESPONSE_SILENCE_MS);await f.observe();assert.equal(f.controls.length,2);assert.equal(f.stops.length,0);
});
test('composed web nudge interruption Stop does not disarm delivery',{timeout:5000},async t=>{
  const f=fixture(t,{watchdog:true});f.delivered();f.advance(1);const observation=f.observe();await f.firstControl.promise;
  f.advance(1);f.appendActivity('post_tool',{tool:'WebFetch',tool_use_id:'web-tool'});f.appendActivity('stop');
  await observation;const delivery=f.supervisor.observer.sceneState(f.scene).delivery;
  assert.ok(delivery);
  await f.observe();assert.ok(f.supervisor.observer.sceneState(f.scene).delivery);
  assert.equal(f.controls.length,2);
});
test('composed Claude queue remove and queued attachment cannot disarm delivery',{timeout:5000},async t=>{
  const f=fixture(t);f.advance(-899700);f.delivered();f.advance(1);f.appendActivity('prompt');const enqueuedAt=f.now();
  f.writeTranscript({type:'queue-operation',operation:'enqueue',timestamp:new Date(enqueuedAt).toISOString(),sessionId:f.scene.sessionId});
  f.advance(49);const removedAt=f.now();
  f.writeTranscript({type:'queue-operation',operation:'remove',reason:'absorbed_mid_turn',timestamp:new Date(removedAt).toISOString(),sessionId:f.scene.sessionId});
  f.writeTranscript({type:'attachment',timestamp:new Date(enqueuedAt).toISOString(),sessionId:f.scene.sessionId,isSidechain:false,
    attachment:{type:'queued_command',commandMode:'prompt',source_uuid:'queued-message',timestamp:new Date(enqueuedAt).toISOString(),humanTurn:true,origin:{kind:'human'}}});
  await f.observe();
  assert.ok(f.supervisor.observer.sceneState(f.scene).delivery);
  f.advance(NO_RESPONSE_SILENCE_MS);await f.observe();assert.equal(f.controls.length,2);
});

for (const runtime of ['claude', 'codex']) {
  for (const nudged of [false, true]) {
    for (const kind of runtime === 'claude' ? ['text', 'thinking', 'call'] : ['text', 'call']) {
      test(`composed ${runtime} ${kind} work permanently disarms ${nudged ? 'nudged' : 'queued'} delivery without Stop`, { timeout: 5000 }, async t => {
        const f = fixture(t, { runtime });
        if (nudged) await f.observe();
        else f.advance(-NO_RESPONSE_SILENCE_MS + 1);
        if (runtime === 'codex') f.writeTranscript({ type: 'session_meta', timestamp: new Date(f.now()).toISOString(), payload: { id: f.scene.sessionId } });
        // The new paste is still queued while AI works on the previous turn.
        f.advance(1); f.delivered(); f.appendActivity('prompt');
        if (runtime === 'claude') {
          f.writeTranscript({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(f.now()).toISOString(), sessionId: f.scene.sessionId });
        }
        await f.observe();
        assert.ok(f.supervisor.observer.sceneState(f.scene).delivery, 'input effects cannot disarm monitoring');
        f.advance(1);
        const timestamp = new Date(f.now()).toISOString();
        const content = kind === 'text' ? { type: 'text', text: 'Working on the older request.' }
          : kind === 'thinking' ? { type: 'thinking', thinking: 'Considering the next step.' }
            : { type: 'tool_use', id: 'tool-call', name: 'Read', input: { file_path: '/tmp/example' } };
        const payload = kind === 'text' ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working on the older request.' }] }

            : { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"pwd"}' };
        f.writeTranscript(runtime === 'claude'
          ? { type: 'assistant', sessionId: f.scene.sessionId, isSidechain: false, timestamp, message: { role: 'assistant', model: 'claude-fixture', content: [content] } }
          : { type: 'response_item', timestamp, payload });
        await f.observe();
        assert.equal(f.supervisor.observer.sceneState(f.scene).delivery.noResponseEligible, false);
        assert.equal(f.supervisor.observer.sceneState(f.scene).delivery.recovery, null);
        f.advance(NO_RESPONSE_SILENCE_MS + NO_RESPONSE_GRACE_MS); await f.observe();
        f.advance(NO_RESPONSE_SILENCE_MS); await f.observe();
        assert.equal(f.controls.length, nudged ? 2 : 0, 'AI work disarms permanently, without restarting the timer');
        assert.equal(f.stops.length, 0);
        assert.deepEqual(f.errors, []);
      });
    }
  }
}
