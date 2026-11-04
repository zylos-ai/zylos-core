import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { tmuxNameForGroup, groupRunDir } from '../../../../cli/lib/session-group-paths.js';
import { createDispatcher } from '../../../comm-bridge/scripts/router/factory.js';
const worker = fileURLToPath(new URL('./fixtures/supervisor-manual-worker.js', import.meta.url));
function start(t, f, requestsFile, mode, pause) {
  const child = spawn(process.execPath, [worker, path.join(f.root, 'comm-bridge/c4.db'), f.socketPath, f.binary, requestsFile, mode, pause],
    { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const message = Promise.race([once(child, 'message').then(([value]) => value), exited.then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
  return { child, exited, message };
}
// Real crash windows with durable intent and a private SQLite gate.
// Run identity pins the target; renamed runs and replacements survive.
// Run for manual F9 compatibility, stop/fence order or recovery changes; skip
// unrelated lifecycle work. Require runner-isolated HOME/ZYLOS_DIR/PM2_HOME,
// short TMPDIR, a private -S tmux socket and temporary database. Workers and
// fixture processes/sockets are closed by cleanup; never use live resources.
for (const mode of ['single', 'multi']) for (const pause of ['after-intent', 'after-fence', 'after-stop', 'after-clear']) {
  test(`manual ${mode} resumes after SIGKILL ${pause} without stopping replacement`, { timeout: 15000 }, async t => {
    const f = readyTmuxTarget(t, { prefix: 'supervisor-manual-', mode });
    f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
    const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
    const scenes = new SupervisorScenes({ env: f.env, connectionOptions: { socketPath: f.socketPath, binary: f.binary }, readMode: () => ({ mode }) });
    const file = path.join(f.root, 'activity-monitor/restart-requests.json');
    const store = new RestartRequestStore({ file });
    const admission = new SupervisorAdmission({ store, db, readMode: () => ({ mode }), readRun: group => scenes.readRun(group) });
    admission.openEntry();
    assert.equal((await admission.handle({ version: 1, type: 'manual_restart', requestId: 'manual-1', expectedRunId: 'run-1' })).result, 'accepted');
    const original = store.read()[0];
    const first = start(t, f, file, mode, pause);
    assert.deepEqual(await first.message, { barrier: pause });
    first.child.kill('SIGKILL'); await first.exited;
    assert.deepEqual(store.read(), [original]);
    const group = mode === 'single' ? '*' : 'origin';
    assert.equal(db.getDrainFence(group)?.reason ?? null, ['after-fence', 'after-stop'].includes(pause) ? 'manual_restart' : null);
    if (['after-intent', 'after-fence'].includes(pause)) f.tmux('rename-session', '-t', '=zylos-group-origin', 'old-renamed');
    f.tmux('new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=replacement', 'sleep', '120');
    const second = start(t, f, file, mode, '');
    assert.deepEqual(await second.message, { result: 'done' });
    assert.equal((await second.exited)[0], 0);
    assert.deepEqual(store.read(), []); assert.equal(db.getDrainFence(group), null);
    if (['after-intent', 'after-fence'].includes(pause)) {
      assert.equal(f.tmux('show-environment', '-t', '=old-renamed', 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=run-1');
    }
    assert.equal(f.tmux('show-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=replacement');
  });
}


// Boundary: actual lifecycle, F9, SQLite fences and private tmux stop only the
// explicit group. Run for manual-target or inflight-gate changes; skip unrelated
// lifecycle work. Fresh HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, private -S socket,
// fixture C4 database, no live processes/network; fixture cleanup closes all.
test('ordinary manual lifecycle stops only its target and retains intent until its own inflight clears', { timeout: 20000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'group-stop-', mode: 'multi', runtimeProcess: true });
  const group = 'fixture:a', other = 'fixture:b';
  const env = { ...f.env, PM2_HOME: path.join(f.root, 'pm2'), TMPDIR: path.join(f.root, 'tmp'), TMUX_TMPDIR: f.root };
  delete env.TMUX;
  fs.mkdirSync(env.TMPDIR);
  console.log(JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME,
    TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, TMUX: env.TMUX ?? null, socket: f.socketPath,
    database: path.join(f.root, 'comm-bridge/c4.db') }));
  assert.ok(f.root.startsWith('/tmp/')); assert.ok(Buffer.byteLength(f.socketPath) < 100);
  const put = (key, runId, sessionId) => {
    const dir = groupRunDir(key, env); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current-session.json'), JSON.stringify({ runId, sessionId, ts: 1, startupControlIds: [] }));
    f.tmux('new-session', '-d', '-s', tmuxNameForGroup(key), '-e', `ZYLOS_RUN_ID=${runId}`,
      '-e', `ZYLOS_SESSION_GROUP=${key}`, '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', path.join(f.root, 'claude'), '120');
  };
  put(group, 'run-a', 'session-a'); put(other, 'run-b', 'session-b');
  const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const scenes = new SupervisorScenes({ env, connectionOptions: { socketPath: f.socketPath, binary: f.binary }, readMode: () => ({ mode: 'multi' }) });
  const store = new RestartRequestStore({ file: path.join(f.root, 'activity-monitor/restart-requests.json') });
  const admission = new SupervisorAdmission({ store, db, readMode: () => ({ mode: 'multi' }), readRun: key => scenes.readRun(key) });
  admission.openEntry();
  const request = { version: 1, type: 'manual_restart', requestId: 'group-stop', sessionGroup: group, expectedRunId: 'run-a' };
  assert.equal((await admission.handle(request)).result, 'accepted');
  const events = [], lifecycle = new SupervisorLifecycle({ db, requests: store,
    observeGroup: key => scenes.observeGroup(key), stop: scene => scenes.stop(scene), diagnostic: event => events.push(event) });
  const context = { configuration: { mode: 'multi' }, transition: null, fences: [], restartRequests: store.read(), scenes: await scenes.observe({ configuration: { mode: 'multi' } }) };
  assert.equal(lifecycle.allowed('origin', context), true);
  assert.equal(lifecycle.allowed(group, context), false);
  assert.equal(lifecycle.allowed(other, context), true);
  const insert = key => f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture','inflight','running',?)").run(key);
  insert(group); insert(other);
  await lifecycle.advanceManual(context);
  assert.equal((await scenes.observeGroup(group)).present, false);
  assert.equal((await scenes.observeGroup('origin')).runId, 'run-1');
  assert.equal((await scenes.observeGroup(other)).runId, 'run-b');
  assert.deepEqual(db.getDrainFence(group), { sessionGroup: group, reason: 'manual_restart', runId: 'run-a', createdAt: db.getDrainFence(group).createdAt });
  assert.equal(store.read().length, 1);
  assert.equal(lifecycle.allowed(group, context), false);
  f.db.prepare("UPDATE conversations SET status='delivered' WHERE session_group=?").run(group);
  await lifecycle.advanceManual(context);
  assert.deepEqual(store.read(), []); assert.equal(db.getDrainFence(group), null);
  assert.equal(db.countRunningConversations(other), 1);
  assert.ok(events.some(event => event.event === 'manual_restart_done' && event.session_group === group));
  assert.equal(lifecycle.allowed(group, context), true);
});

// Boundary: real Router scheduling after the manual fence/F9 are withdrawn.
// Run for ordinary-group restart completion or activation changes; skip unrelated
// lifecycle changes. Fresh HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and private socket,
// temporary C4/F9, fixture launch adapter; no live tmux/database/network.
for (const pending of [false, true]) test(`ordinary manual restart uses normal on-demand activation with pending=${pending}`, { timeout: 20000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'group-demand-', mode: 'multi', runtimeProcess: true });
  const group = 'fixture:a', name = tmuxNameForGroup(group);
  const env = { ...f.env, PM2_HOME: path.join(f.root, 'pm2'), TMPDIR: path.join(f.root, 'tmp'), TMUX_TMPDIR: f.root };
  delete env.TMUX; fs.mkdirSync(env.TMPDIR);
  console.log(JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME,
    TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, TMUX: env.TMUX ?? null, socket: f.socketPath,
    database: path.join(f.root, 'comm-bridge/c4.db') }));
  assert.ok(f.root.startsWith('/tmp/')); assert.ok(Buffer.byteLength(f.socketPath) < 100);
  const put = runId => {
    const dir = groupRunDir(group, env); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current-session.json'), JSON.stringify({ runId, sessionId: runId, ts: Date.now(), startupControlIds: [] }));
    f.tmux('new-session', '-d', '-s', name, '-e', `ZYLOS_RUN_ID=${runId}`, '-e', `ZYLOS_SESSION_GROUP=${group}`,
      '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', path.join(f.root, 'claude'), '120');
  };
  put('old-a');
  const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const scenes = new SupervisorScenes({ env, connectionOptions: { socketPath: f.socketPath, binary: f.binary }, readMode: () => ({ mode: 'multi' }) });
  const store = new RestartRequestStore({ file: path.join(f.root, 'activity-monitor/restart-requests.json') });
  const admission = new SupervisorAdmission({ store, db, readMode: () => ({ mode: 'multi' }), readRun: key => scenes.readRun(key) });
  admission.openEntry();
  assert.equal((await admission.handle({ version: 1, type: 'manual_restart', requestId: 'demand', sessionGroup: group, expectedRunId: 'old-a' })).result, 'accepted');
  if (pending) f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture','after restart','pending',?)").run(group);
  const lifecycle = new SupervisorLifecycle({ db, requests: store, observeGroup: key => scenes.observeGroup(key), stop: scene => scenes.stop(scene) });
  const context = { configuration: { mode: 'multi' }, transition: null, fences: [], restartRequests: store.read(), scenes: await scenes.observe({ configuration: { mode: 'multi' } }) };
  await lifecycle.advanceManual(context);
  assert.equal((await scenes.observeGroup(group)).present, false); assert.deepEqual(store.read(), []);
  const launches = [];
  const routerDb = { ...db, expireTimedOutControls: () => [], cleanupControlQueue: () => {} };
  const dispatcher = createDispatcher({ env, db: routerDb, readSessionMode: () => ({ mode: 'multi', keyPresent: true }),
    readLiveIdentity: key => scenes.observeGroup(key),
    readCurrentSession: async key => JSON.parse(fs.readFileSync(path.join(groupRunDir(key, env), 'current-session.json'), 'utf8')),
    readRuntimeHealth: () => ({ health: 'ok', publicHealth: 'ok' }),
    readSessionState: async () => ({ state: { valid: true, value: 'idle' } }),
    getSessionAdapter: () => ({ launch: async input => { launches.push(input); put(input.runId); }, stop: () => { throw new Error('Unexpected router stop'); } }),
    submit: async () => ({ kind: 'accepted', reply: { ok: true, result: 'not_restricted' } }),
    findLegacySessions: async () => [], advanceLegacy: async () => {}, prepareSingle: async () => {},
    notifyDelivered: async () => {}, log: () => {},
    deliverConversation: async row => db.markDelivered(row.id, { sessionId: 'fixture' }), deliverControl: async () => {},
  }, { poolSize: 4, tmux: { socketPath: f.socketPath, binary: f.binary } });
  t.after(() => dispatcher.stop()); await dispatcher.initialize();
  for (let i = 0; i < 5; i++) { dispatcher.tick(); await dispatcher.idle(); }
  assert.equal(launches.filter(row => row.sessionGroup === group).length, pending ? 1 : 0);
  assert.equal((await scenes.observeGroup(group)).present, pending);
  assert.equal((await scenes.observeGroup('origin')).runId, 'run-1');
  await dispatcher.stop();
});
