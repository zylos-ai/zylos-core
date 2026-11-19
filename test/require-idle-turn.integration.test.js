import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bind import-time database/config paths independently of other test files.
const fileRoot = fs.mkdtempSync('/tmp/idle-turn-file-');
after(() => fs.rmSync(fileRoot, { recursive: true, force: true }));
for (const [key, directory] of Object.entries({
  HOME: 'home', ZYLOS_DIR: 'home/zylos', PM2_HOME: 'home/.pm2', TMPDIR: 'tmp',
})) {
  const value = path.join(fileRoot, directory);
  fs.mkdirSync(value, { recursive: true });
  process.env[key] = value;
  assert.equal(fs.realpathSync(process.env[key]), fs.realpathSync(value));
  assert.ok(process.env[key].startsWith(fileRoot + path.sep));
}
assert.equal(os.homedir(), process.env.HOME);
assert.equal(os.tmpdir(), process.env.TMPDIR);
console.log(JSON.stringify({ fileRoot, HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR }));

const c4db = await import('../skills/comm-bridge/scripts/c4-db.js');
const { DB_PATH } = await import('../skills/comm-bridge/scripts/c4-config.js');
const { createStore } = await import('../skills/comm-bridge/scripts/c4-v2-store.js');
const { createDelivery } = await import('../skills/comm-bridge/scripts/router/delivery.js');
const { createLane } = await import('../skills/comm-bridge/scripts/router/lane.js');
const { handleHookActivity } = await import('../skills/activity-monitor/scripts/hook-activity.js');
const { OPEN_TURN_INACTIVITY_TIMEOUT_MS } = await import('../skills/activity-monitor/scripts/session-activity.js');
const { createSupervisor } = await import('../skills/activity-monitor/scripts/supervisor.js');
const { RestartRequestStore } = await import('../skills/activity-monitor/scripts/restart-request-store.js');
const { publishSessionStatus } = await import('../skills/activity-monitor/scripts/status-writer.js');
const { runDirFromEnv } = await import('../cli/lib/session-group-paths.js');
assert.equal(DB_PATH, path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db'));
assert.ok(DB_PATH.startsWith(fileRoot + path.sep));

let fixtureSequence = 0;
function fixture(t, { mode = 'single', runtime = 'claude', group = null, pausePaste = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: `isolated-run-${++fixtureSequence}`,
    ZYLOS_MODEL_CONFIG: JSON.stringify({ runtime }) };
  delete env.ZYLOS_SESSION_GROUP;
  if (group) env.ZYLOS_SESSION_GROUP = group;
  const runDir = runDirFromEnv(env).dir;
  const socketPath = path.join(root, 'tmux.sock');
  assert.ok(socketPath.startsWith(root + path.sep));
  assert.ok(DB_PATH.startsWith(fileRoot + path.sep));
  console.log(JSON.stringify({ mode, runtime, group, HOME: env.HOME, ZYLOS_DIR: root,
    PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, socketPath, database: DB_PATH }));
  let now = Date.now(), present = true;
  const startedAt = now;
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  fs.utimesSync(transcript, now / 1000, now / 1000);
  const hook = (event, more = {}) => handleHookActivity({ hook_event_name: event,
    session_id: 'isolated-session', transcript_path: transcript, ...more }, { env, nowMs: now });
  hook('SessionStart'); hook('UserPromptSubmit');
  const database = c4db.getDb();
  t.after(() => {
    c4db.close();
    // This database belongs only to this file; each sequential case starts empty.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
  });
  const store = { ...c4db, ...createStore(database, { now: () => now,
    readConfig: () => ({ state: 'ok', config: { session_mode: mode, runtime } }),
    validateComponent: () => true, validateModel: () => true }) };
  const target = { present: true, ready: true, runtime, runId: env.ZYLOS_RUN_ID,
    runtimeSessionId: 'isolated-session', sessionId: '$1', paneId: '%1', serverGeneration: 'isolated' };
  const scene = { sessionGroup: group ?? 'origin', present: true, ready: true, processRunning: true,
    runtime, runId: env.ZYLOS_RUN_ID, sessionId: 'isolated-session', runDir,
    createdAt: startedAt - 1, currentSessionTs: startedAt - 1,
    tmuxTarget: { serverGeneration: target.serverGeneration, sessionId: target.sessionId, paneId: target.paneId } };
  const calls = [], pasted = [], keys = [], stops = [], routed = [];
  const scenes = {
    observe: async () => present ? [scene] : [],
    readIdentity: async () => ({ ...scene, present, ready: present }),
    bindTarget: async () => ({ expectedRunId: scene.runId, tmuxTarget: scene.tmuxTarget }),
    readScreen: async () => '❯ ',
    stop: async value => { stops.push(value.runId); present = false; scene.present = false; scene.ready = false; scene.processRunning = false; },
  };
  const supervisor = createSupervisor({ db: store, scenes, zylosDir: root, env,
    readConfiguration: async () => ({ mode, runtime }), readMode: async () => ({ mode }), resolveTargetRuntime: async () => runtime,
    requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
    readSyncMarker: async () => null, resolveToolRule: async () => null,
    matchScreen: async () => ({}), checkAuth: async () => ({ status: 'uncertain' }),
    now: () => now, log: value => calls.push(['log', value]),
    loopOptions: { schedule: () => 1, cancel: () => {} } });
  t.after(() => supervisor.stop());
  const read = () => supervisor.readActivity(scene);
  const sample = () => publishSessionStatus({ statusFile: path.join(root, 'status.json'),
    scene, activity: read(), health: { health: 'ok' }, now });
  let releasePaste, pastedReady;
  const pasteReady = new Promise(resolve => { pastedReady = resolve; });
  const pasteGate = new Promise(resolve => { releasePaste = resolve; });
  t.after(() => releasePaste());
  const delivery = createDelivery({ db: store, getSessionMode: () => mode, now: () => now,
    sleep: async ms => { now += ms; },
    openTmuxConnection: async () => ({ close: async () => {}, command: async () => '0' }),
    resolveSessionTarget: async ({ sessionGroup }) => { routed.push(sessionGroup); return target; },
    revalidateSessionTarget: async () => {},
    readSessionState: async () => ({ identity: { ...target }, status: { valid: true, value: sample() } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => ({ runId: scene.runId, sessionId: scene.sessionId }),
    formatConversation: row => row.content,
    session: {
      sendText: async ({ text }) => { calls.push(['paste-start', text]); pasted.push(text); pastedReady(); if (pausePaste) await pasteGate; calls.push(['paste-end', text]); },
      sendKeys: async ({ keys: value }) => { calls.push(['key', ...value]); keys.push(value); },
      captureScreen: async () => '❯ ',
    }, notifyDelivered: () => {},
  }, { periodicEnabled: false, captureEnabled: false, idleHoldMs: 0 });
  t.after(() => delivery.stop());
  const row = id => store.getControlById(id);
  const escapeRows = () => database.prepare("SELECT * FROM control_queue WHERE raw_content='[KEYSTROKE]Escape' AND json_extract(target_binding,'$.expectedRunId')=? ORDER BY id").all(scene.runId);
  const append = value => { fs.appendFileSync(transcript, JSON.stringify(value) + '\n'); fs.utimesSync(transcript, now / 1000, now / 1000); };
  const output = () => append(runtime === 'claude'
    ? { type: 'assistant', sessionId: scene.sessionId, timestamp: new Date(now).toISOString(),
      message: { role: 'assistant', model: 'isolated-model', content: [{ type: 'text', text: 'Working.' }] } }
    : { type: 'response_item', timestamp: new Date(now).toISOString(),
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working.' }] } });
  if (runtime === 'codex') append({ type: 'session_meta', payload: { id: scene.sessionId } });
  return { root, env, runDir, transcript, startedAt, store, database, scene, supervisor, delivery, hook,
    sample, read, row, escapeRows, append, output, calls, pasted, keys, stops, routed,
    now: () => now, at: value => { now = value; }, advance: ms => { now += ms; }, pasteReady, releasePaste,
    async deliver(row) { assert.equal(store.claimControl(row.id), true); return delivery.deliverControl(store.getControlById(row.id)); },
    async interrupt() { return supervisor.interruptQuietTurn(scene); },
    async observe() { return supervisor.loop.deps.probeAndPublish(scene, { configuration: { mode, runtime }, scenes: [scene] }); },
  };
}

// Boundary: native hooks/transcripts -> actual Supervisor inactivity action ->
// real SQLite control queue -> delivery/ack/status. Terminal I/O is injected.
// Run for turn/inactivity/control-ordering changes; skip unrelated UI/docs work.
// Official runner plus this file isolate HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR
// and database before imports; each fixture reserves a private unused tmux socket.
for (const mode of ['single', 'multi']) for (const runtime of ['claude', 'codex']) {
  for (const group of mode === 'single' ? [null] : ['origin', 'telegram:isolated']) {
    const outputs = runtime === 'claude' ? ['quiet', ...(mode === 'single' ? ['streaming'] : []), 'foreground-bash', 'foreground-agent', 'escaped-tool'] : ['quiet'];
    for (const output of outputs) for (const ending of output.startsWith('foreground-') || output === 'streaming' ? ['stop'] : output === 'escaped-tool' ? ['inactivity'] : runtime === 'codex' ? ['stop', 'inactivity', 'api-error'] : ['stop', 'inactivity']) {
      test(`${mode} ${runtime} ${group ?? 'origin'} holds idle controls through ${output} and delivers once after ${ending}`, { timeout: 5000 }, async t => {
        const f = fixture(t, { mode, runtime, group });
        const controls = [runtime === 'codex' ? '/exit' : '/clear', 'Memory Sync requested']
          .map(content => f.store.insertControl(content, { sessionGroup: group, priority: 1, requireIdle: true, appendAckSuffix: false }));
        const hasTool = output.startsWith('foreground-') || output === 'escaped-tool';
        if (hasTool) f.hook('PreToolUse', { tool_use_id: 'foreground', tool_name: output === 'foreground-agent' ? 'Agent' : 'Bash' });
        if (output === 'foreground-agent') f.hook('SubagentStart', { agent_id: 'foreground-child' });
        const hookBytes = fs.statSync(path.join(f.runDir, 'events.jsonl')).size;
        const samples = output === 'streaming' ? [5000, 60000, 600000, 1199999] : hasTool ? [5000, 1199999, 1200000, 1800000] : [5000, 68000, 899999, 1199999];
        for (const elapsed of samples) {
          f.at(f.startedAt + elapsed);
          if (output === 'streaming') { f.output(); f.advance(4000); }
          const observed = f.read();
          assert.equal(observed.state, 'busy'); assert.equal(observed.turnOpen, true);
          assert.equal(observed.tools.length, hasTool ? 1 : 0);
          await f.interrupt();
          assert.equal(f.escapeRows().length, 0);
          assert.equal(fs.statSync(path.join(f.runDir, 'events.jsonl')).size, hookBytes);
          for (const control of controls) {
            assert.equal((await f.deliver(control)).blocked, true);
            assert.equal(f.row(control.id).status, 'pending'); assert.equal(f.row(control.id).retry_count, 0);
          }
          assert.equal(f.pasted.length, 0); assert.equal(f.keys.length, 0);
        }
        if (ending === 'stop') {
          if (hasTool) { f.hook('PostToolUse', { tool_use_id: 'foreground' }); f.advance(4000); assert.equal(f.read().turnOpen, true); }
          f.hook('Stop'); f.advance(4000);
        } else {
          if (output === 'escaped-tool') {
            f.append({ type: 'user', sessionId: f.scene.sessionId, timestamp: new Date(f.now()).toISOString(),
              message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'foreground', is_error: true, content: 'Interrupted by user' }] } });
            assert.equal(f.read().tools.length, 0);
          }
          if (ending === 'api-error') f.append({ type: 'event_msg', timestamp: new Date(f.now()).toISOString(), payload: { type: 'error', message: 'API request failed' } });
          const lastActivityAt = f.read().lastActivityAt;
          f.at(lastActivityAt + OPEN_TURN_INACTIVITY_TIMEOUT_MS - 1);
          await f.interrupt(); assert.equal(f.escapeRows().length, 0); assert.equal(f.sample().state, 'busy');
          f.advance(1);
          assert.equal(f.read().quietTurnDue, true);
          await f.interrupt();
          const escapes = f.escapeRows();
          assert.equal(escapes.length, 1); assert.equal(escapes[0].content, '[KEYSTROKE]Escape');
          assert.equal(escapes[0].require_idle, 0); assert.equal(escapes[0].bypass_state, 1);
          const filter = group === null ? undefined : { sessionGroups: [group] };
          assert.equal(f.store.getNextPendingControl(Math.floor(f.now() / 1000), filter).id, escapes[0].id, 'Escape precedes older normal-priority idle controls');
          assert.equal((await f.deliver(escapes[0])).delivered, true);
          assert.equal(f.row(escapes[0].id).status, 'done');
          for (const elapsed of [1, 1000, OPEN_TURN_INACTIVITY_TIMEOUT_MS]) { f.advance(elapsed); await f.interrupt(); }
          assert.equal(f.escapeRows().length, 1); assert.equal(f.keys.filter(value => value[0] === 'Escape').length, 1);
        }
        assert.equal(f.sample().state, 'idle');
        for (const control of controls) {
          assert.equal((await f.deliver(control)).delivered, true);
          assert.equal(f.row(control.id).status, 'done'); assert.equal(f.store.claimControl(control.id), false);
        }
        assert.equal(f.pasted.length, controls.length);
        for (const control of controls) assert.equal(f.pasted.filter(value => value === (control.content.startsWith('/') ? control.content : `Meanwhile, ${control.content}`)).length, 1);
        await f.interrupt();
        assert.equal(f.escapeRows().length, ending === 'stop' ? 0 : 1);
        assert.ok(f.routed.every(value => value === group));
      });
    }
  }
}

// Boundary: a real model transcript disarms no-response recovery; the production
// observation/publication action then admits one inactivity Escape and idle work.
// Run for response/inactivity coordination changes; skip unrelated UI/docs. Same
// isolated env/database/socket fixture, injected terminal I/O, no child processes.
for (const runtime of ['claude', 'codex']) test(`${runtime} AI work followed by an unclosed silent turn gets one inactivity Escape`, { timeout: 5000 }, async t => {
  const f = fixture(t, { runtime });
  f.supervisor.observer.notifyDelivered({ ...f.scene, pastedAt: f.startedAt });
  f.advance(1000); f.output();
  await f.observe();
  const tracked = f.supervisor.observer.sceneState(f.scene);
  assert.equal(tracked.delivery.noResponseEligible, false);
  assert.equal(f.read().lastResponseAt, f.now());
  const lastActivityAt = f.read().lastActivityAt;
  const controls = ['/clear', 'Memory Sync requested'].map(content => f.store.insertControl(content,
    { sessionGroup: null, priority: 1, requireIdle: true, appendAckSuffix: false }));
  for (const elapsed of [900000, 1080000, OPEN_TURN_INACTIVITY_TIMEOUT_MS - 1]) {
    f.at(lastActivityAt + elapsed); await f.observe();
    assert.equal(f.read().state, 'busy'); assert.equal(f.escapeRows().length, 0);
    assert.equal(tracked.delivery.recovery, null); assert.equal(f.stops.length, 0);
  }
  f.advance(1); await f.observe();
  assert.equal(f.read().state, 'idle'); assert.equal(f.escapeRows().length, 1);
  assert.equal(tracked.delivery.recovery, null); assert.equal(f.stops.length, 0);
  const escape = f.store.getNextPendingControl(Math.floor(f.now() / 1000));
  assert.equal(escape.content, '[KEYSTROKE]Escape');
  assert.equal(escape.priority, 0);
  // Same-second insertion exercises the id tie-breaker in the real queue.
  const laterControl = f.store.insertControl('Later idle control',
    { sessionGroup: null, priority: 0, requireIdle: true, appendAckSuffix: false });
  assert.equal(laterControl.created_at, escape.created_at);
  assert.ok(laterControl.id > escape.id);
  assert.equal(f.store.getNextPendingControl(Math.floor(f.now() / 1000)).id, escape.id);
  assert.equal((await f.deliver(escape)).delivered, true);
  assert.equal(f.store.getNextPendingControl(Math.floor(f.now() / 1000)).id, laterControl.id);
  assert.equal((await f.deliver(laterControl)).delivered, true);
  for (const control of controls) assert.equal((await f.deliver(control)).delivered, true);
  for (const elapsed of [1, 1000, OPEN_TURN_INACTIVITY_TIMEOUT_MS]) { f.advance(elapsed); await f.observe(); }
  assert.equal(f.escapeRows().length, 1); assert.equal(f.keys.filter(value => value[0] === 'Escape').length, 1);
  assert.equal(f.pasted.length, controls.length + 1);
  for (const control of [...controls, laterControl]) assert.equal(f.store.claimControl(control.id), false);
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM control_queue WHERE raw_content='continue'").get().count, 0);
});

// Boundary: actual group lane owns an in-flight paste/Enter verification while
// the Supervisor admits Escape into real SQLite; no direct terminal path is used.
// Run when queue priority, inactivity insertion or lane serialization changes;
// skip unrelated UI/docs. Same file/fixture isolation; no background processes.
for (const runtime of ['claude', 'codex']) test(`${runtime} queued inactivity Escape waits for in-flight message submission`, { timeout: 5000 }, async t => {
  const f = fixture(t, { runtime, pausePaste: true });
  f.advance(1000); f.output(); f.read();
  const message = f.store.insertConversation('in', 'telegram', 'isolated', 'keep this message');
  const state = { mode: 'single', stopped: false, live: new Map([[null, { present: true, ready: true, runId: f.scene.runId, sessionId: f.scene.sessionId }]]), activations: new Map() };
  const lane = createLane({ state, now: f.now, options: { pendingMaxAgeSeconds: 3600 }, diagnostic() {}, capacityWaits: { clear() {} }, deps: {
    db: f.store, readCurrentSession: async () => ({ runId: f.scene.runId, sessionId: f.scene.sessionId, startupControlIds: [] }),
    deliverConversation: f.delivery.deliverConversation, deliverControl: f.delivery.deliverControl,
  } }, null);
  t.after(() => lane.stop());
  const running = lane.kick();
  try {
    await f.pasteReady;
    f.at(f.read().lastActivityAt + OPEN_TURN_INACTIVITY_TIMEOUT_MS);
    await f.interrupt();
    assert.equal(f.escapeRows().length, 1); assert.equal(f.escapeRows()[0].status, 'pending');
    assert.equal(lane.kick(), running);
    assert.equal(f.keys.length, 0, 'Escape cannot enter while sendText is suspended');
  } finally { f.releasePaste(); }
  await running;
  const persisted = f.database.prepare('SELECT status FROM conversations WHERE id=?').get(message.id);
  assert.equal(persisted.status, 'delivered');
  assert.equal(f.escapeRows()[0].status, 'pending');
  await lane.kick();
  assert.equal(f.escapeRows()[0].status, 'done');
  assert.deepEqual(f.calls.filter(value => value[0] !== 'log'), [['paste-start', 'keep this message'], ['paste-end', 'keep this message'], ['key', 'Enter'], ['key', 'Escape']]);
  await lane.kick(); await f.interrupt();
  assert.equal(f.escapeRows().length, 1); assert.equal(f.keys.filter(value => value[0] === 'Escape').length, 1);
});

// Boundary: actual health observer/no-response pair + inactivity admission share
// one run. Run when these timers/actions change; skip unrelated UI/docs. Same
// isolated SQLite/env; fake scene stop, no native runtime or background processes.
for (const runtime of ['claude', 'codex']) test(`${runtime} no-response recovery stops the run before inactivity can add another Escape`, { timeout: 5000 }, async t => {
  const f = fixture(t, { runtime });
  f.read();
  f.supervisor.observer.notifyDelivered({ ...f.scene, pastedAt: f.startedAt });
  f.at(f.startedAt + 899999); await f.observe();
  assert.equal(f.escapeRows().length, 0);
  f.advance(1); await f.observe();
  assert.equal(f.escapeRows().length, 1);
  const controls = f.database.prepare("SELECT * FROM control_queue WHERE json_extract(target_binding,'$.expectedRunId')=? ORDER BY id").all(f.scene.runId);
  assert.equal(controls.length, 2); assert.equal(controls[0].content, '[KEYSTROKE]Escape'); assert.equal(controls[1].content, 'continue');
  for (const control of controls) assert.equal((await f.deliver(control)).delivered, true);
  const recovery = f.supervisor.observer.sceneState(f.scene).delivery.recovery;
  f.at(recovery.nudgedAt + 179999); await f.observe(); assert.equal(f.stops.length, 0);
  f.advance(1); await f.observe(); assert.equal(f.stops.length, 1);
  f.at(f.startedAt + OPEN_TURN_INACTIVITY_TIMEOUT_MS); await f.observe();
  assert.equal(f.escapeRows().length, 1); assert.equal(f.keys.filter(value => value[0] === 'Escape').length, 1);
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM control_queue WHERE raw_content='continue' AND json_extract(target_binding,'$.expectedRunId')=?").get(f.scene.runId).count, 1);
  assert.equal(f.stops.length, 1);
});
