import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { fixture, launch, manual, assertReply } from './fixtures/manual-restart-harness.js';
import { tmuxNameForGroup, groupRunDir } from '../../../../cli/lib/session-group-paths.js';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
const Database = createRequire(new URL('../../../comm-bridge/package.json', import.meta.url))('better-sqlite3');
import { MANUAL_WAKE_PROMPT } from '../origin-prompts.js';

const requestFile = f => path.join(f.root, 'activity-monitor/restart-requests.json');
async function assertUntouched(m4, f) {
  const state = await m4.command('state');
  assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []); assert.deepEqual(state.stopped, []);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
  return state;
}
// Boundary: real entry admission, F9 and exact runtime identity. Run for manual
// request identity/compatibility changes; skip unrelated lifecycle behavior.
// Require runner-isolated HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, a private -S
// tmux socket and temporary C4; child/fixture cleanup closes all resources.
for (const mode of ['single', 'multi']) for (const runtime of ['claude', 'codex']) {
  test(`${mode}/${runtime} real supervisor exact target rejection fields and accepted identity`, { timeout: 25000 }, async t => {
    const f = fixture(t, mode, runtime), m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
    let req = manual('no-target'); assertReply(await f.submit(req), req, 'rejected', { reason: 'target_required' }, false);
    req = manual('stale', { expectedRunId: 'old-run' }); assertReply(await f.submit(req), req, 'stale_target', { currentRunId: 'run-1' }, false);
    f.tmux('set-environment', '-u', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID');
    req = manual('missing-id', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'rejected', { reason: 'identity_unavailable' }, false);
    req = manual('missing-id-no-target'); assertReply(await f.submit(req), req, 'rejected', { reason: 'target_required' }, false);
    f.tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'run-1');
    fs.renameSync(f.readyPath, `${f.readyPath}.saved`);
    req = manual('not-ready', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'rejected', { reason: 'not_ready' }, false);
    req = manual('not-ready-no-target'); assertReply(await f.submit(req), req, 'rejected', { reason: 'target_required' }, false);
    fs.renameSync(`${f.readyPath}.saved`, f.readyPath);
    req = manual('stale-session', { expectedRunId: 'run-1', expectedSessionId: 'old-session' }); assertReply(await f.submit(req), req, 'rejected', { reason: 'identity_unavailable' }, false);
    await assertUntouched(m4, f);
    req = manual('accepted', { expectedRunId: 'run-1', expectedSessionId: 'session-1' });
    const before = Date.now(); assertReply(await f.submit(req), req, 'accepted'); const after = Date.now();
    const [row] = JSON.parse(fs.readFileSync(requestFile(f), 'utf8'));
    assert.ok(row.acceptedAt >= before && row.acceptedAt <= after);
    assert.deepEqual(row, { requestId: 'accepted', reason: 'manual_restart', acceptedAt: row.acceptedAt, runIds: ['run-1'], mode, expectedRunId: 'run-1' });
    assertReply(await f.submit(req), req, 'already_accepted');
    const conflict = { ...req, expectedRunId: 'replacement' }; assertReply(await f.submit(conflict), conflict, 'rejected', { reason: 'request_conflict' }, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(requestFile(f), 'utf8')), [row]);
    await m4.command('busy');
    const final = await m4.command('tick');
    assert.equal(final.scene.present, false); assert.deepEqual(final.requests, []); assert.deepEqual(final.fences, []);
    assert.equal(final.stopped.length, 1); assert.equal(final.stopped[0].runId, 'run-1'); assert.equal(final.stopped[0].runtime, runtime);
    assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
    // Ending the old run does not launch or certify a fresh READY.
    assert.equal(JSON.parse(fs.readFileSync(f.readyPath, 'utf8')).runId, 'run-1');
    await m4.stop();
  });
  test(`${mode}/${runtime} actual empty Origin already_stopped has no intent, gate, stop or launch; later appearance survives`, { timeout: 25000 }, async t => {
    const f = fixture(t, mode, runtime); f.tmux('kill-session', '-t', '=zylos-group-origin');
    const m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
    for (const req of [manual('empty'), manual('old-absent', { expectedRunId: 'run-1' })]) {
      assertReply(await f.submit(req), req, 'already_stopped'); const state = await assertUntouched(m4, f); assert.equal(state.scene.present, false);
    }
    f.tmux('new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=late-run', '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify({runtime,mode:'default'})}`, ...(mode === 'multi' ? ['-e', 'ZYLOS_SESSION_GROUP=origin'] : []), path.join(f.root, runtime), '120');
    const state = await m4.command('tick'); assert.equal(state.scene.present, true); assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []); assert.deepEqual(state.stopped, []);
    assert.equal(f.tmux('show-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=late-run');
    await m4.stop();
  });
}

test('actual supervisor empty Origin conflict and corrupt fail closed before already_stopped', { timeout: 25000 }, async t => {
  const f = fixture(t); f.tmux('kill-session', '-t', '=zylos-group-origin');
  const m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  for (const group of ['origin', '*']) {
    db.setDrainFence(group, { reason: 'manual_restart', runId: 'old' }); const before = db.listDrainFences();
    const req = manual(group === '*' ? 'fence-global' : 'fence-origin'); assertReply(await f.submit(req), req, 'rejected', { reason: 'fence_conflict' }, false);
    assert.deepEqual(db.listDrainFences(), before); f.db.exec('DELETE FROM drain_fences');
  }
  const upgrade = [{ requestId: 'upgrade', reason: 'upgrade', acceptedAt: 1, runIds: ['old'] }];
  fs.writeFileSync(requestFile(f), JSON.stringify(upgrade));
  let req = manual('upgrade-conflict'); assertReply(await f.submit(req), req, 'rejected', { reason: 'restart_all_pending' }, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(requestFile(f), 'utf8')), upgrade);
  const damaged = '{broken'; fs.writeFileSync(requestFile(f), damaged);
  req = manual('corrupt'); assertReply(await f.submit(req), req, 'rejected', { reason: 'requests_unreadable' }, false);
  assert.equal(fs.readFileSync(requestFile(f), 'utf8'), damaged); assert.deepEqual(db.listDrainFences(), []);
  fs.writeFileSync(requestFile(f), '[]'); await assertUntouched(m4, f); await m4.stop();
});

// Run after changes to manual completion, wake insertion or fence ordering.
// Uses private HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, tmux socket and C4 DB;
// fixture teardown stops its worker/server and removes its temporary resources.
for (const mode of ['single', 'multi']) test(`${mode} manual restart stops busy Sync-held run despite running control, retains until inflight accounted`, { timeout: 25000 }, async t => {
  await inflight(t, mode);
});
async function inflight(t, mode) {
  const f = fixture(t, mode), m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  const group = mode === 'single' ? null : 'origin';
  f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture','paused paste/Enter','running',?)").run(group ?? '');
  f.db.prepare("INSERT INTO control_queue(raw_content,content,status,ack_deadline_at,created_at,updated_at,session_group) VALUES('control','control','running',NULL,1,1,?)").run(group);
  const conversation = f.db.prepare('SELECT * FROM conversations').all(), control = f.db.prepare('SELECT * FROM control_queue').all();
  await m4.command('busy');
  const req = manual('manual-inflight', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'accepted');
  const row = JSON.parse(fs.readFileSync(requestFile(f), 'utf8'));
  const stopped = await m4.command('tick');
  assert.equal(stopped.scene.present, false); assert.equal(stopped.stopped.length, 1);
  assert.deepEqual(stopped.requests, row, 'manual inflight intent must persist'); assert.equal(stopped.fences.length, 1);
  assert.equal(stopped.fences[0].sessionGroup, mode === 'single' ? '*' : 'origin');
  assert.equal(stopped.fences[0].reason, 'manual_restart'); assert.equal(stopped.fences[0].runId, 'run-1');
  assert.deepEqual(f.db.prepare('SELECT * FROM conversations').all(), conversation);
  assert.deepEqual(f.db.prepare('SELECT * FROM control_queue').all(), control);
  f.db.exec("UPDATE conversations SET status='delivered'");
  const done = await m4.command('tick'); assert.deepEqual(done.requests, []); assert.deepEqual(done.fences, []);
  const controlsAfter = f.db.prepare('SELECT * FROM control_queue ORDER BY id').all();
  if (mode === 'single') assert.deepEqual(controlsAfter, control);
  else {
    assert.equal(controlsAfter.length, control.length + 1);
    assert.deepEqual(controlsAfter.slice(0, control.length), control);
    const wake = controlsAfter.at(-1);
    assert.equal(wake.session_group, 'origin'); assert.equal(wake.target_binding, null);
    assert.equal(wake.priority, 2); assert.equal(wake.status, 'pending');
    assert.equal(wake.raw_content, MANUAL_WAKE_PROMPT); assert.equal(wake.content, MANUAL_WAKE_PROMPT);
    const clears = done.events.filter(event => event.event === 'before_fence_clear');
    assert.equal(clears.length, 1);
    assert.deepEqual(clears[0].fence, stopped.fences[0], 'manual gate still held when wake is persisted');
    assert.deepEqual(clears[0].controls, controlsAfter, 'wake must exist before the real fence clear');
  }
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await m4.stop();
}


for (const mode of ['single', 'multi']) for (const pause of ['before-intent', 'after-intent', 'after-fence', 'after-stop', 'after-clear', 'before-remove', 'after-remove']) {
  test(`${mode} full supervisor SIGKILL ${pause} recovers durable intent without resubmission or retargeting`, { timeout: 25000 }, async t => {
    await crashWindow(t, mode, pause);
  });
}
async function crashWindow(t, mode, pause) {
  const f = fixture(t, mode), first = launch(t, f, pause); assert.equal((await first.next()).ready, true);
  const req = manual('crash-scene', { expectedRunId: 'run-1' });
  let pending;
  if (['before-intent', 'after-intent'].includes(pause)) pending = f.submit(req);
  else { assertReply(await f.submit(req), req, 'accepted'); first.child.send('tick'); }
  assert.deepEqual(await first.next(), { barrier: pause }); await first.kill();
  if (pending) assert.deepEqual(await pending, { kind: 'no_reply', sent: true });
  const rows = fs.existsSync(requestFile(f)) ? JSON.parse(fs.readFileSync(requestFile(f), 'utf8')) : [];
  assert.equal(rows.length, ['before-intent', 'after-remove'].includes(pause) ? 0 : 1);
  if (rows.length) assert.deepEqual(rows[0], { requestId: req.requestId, reason: 'manual_restart', acceptedAt: rows[0].acceptedAt, runIds: ['run-1'], mode, expectedRunId: 'run-1' });
  const beforeStop = ['before-intent', 'after-intent', 'after-fence'].includes(pause);
  if (beforeStop) f.tmux('rename-session', '-t', '=zylos-group-origin', 'fixture-original');
  f.tmux('new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=replacement', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', ...(mode === 'multi' ? ['-e', 'ZYLOS_SESSION_GROUP=origin'] : []), path.join(f.root, 'claude'), '120');
  fs.writeFileSync(f.readyPath, JSON.stringify({ ...f.ready, runId: 'replacement', sessionId: 'replacement-session' }));
  const second = launch(t, f), state = await second.next(); assert.equal(state.ready, true);
  assert.equal(state.scene.present, true, 'replacement must remain present'); assert.equal(state.scene.runId, 'replacement'); assert.deepEqual(state.stopped, []);
  assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []);
  if (beforeStop) assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-original'));
  const done = await second.command('tick'); assert.deepEqual(done.stopped, []); assert.deepEqual(done.requests, []);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await second.stop();
}


for (const mode of ['single', 'multi']) test(`${mode} actual supervisor transition/fence conflict holds accepted manual identity and does not reuse global gate`, { timeout: 25000 }, async t => {
  const f = fixture(t, mode), m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  const req = manual('transition-conflict', { expectedRunId: 'run-1' });
  const transition = () => f.db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('transition',?,?,'gating',1,1)").run(mode, mode === 'single' ? 'multi' : 'single');
  transition();
  assertReply(await f.submit(req), req, 'rejected', { reason: 'transition_open' }, false);
  f.tmux('rename-session', '-t', '=zylos-group-origin', 'fixture-hidden');
  const empty = manual('empty-transition'); assertReply(await f.submit(empty), empty, 'rejected', { reason: 'transition_open' }, false);
  f.tmux('rename-session', '-t', '=fixture-hidden', 'zylos-group-origin');
  f.db.exec('DELETE FROM mode_transitions');
  assertReply(await f.submit(req), req, 'accepted');
  const accepted = JSON.parse(fs.readFileSync(requestFile(f), 'utf8'));
  const otherManual = manual('second-manual', { expectedRunId: 'run-1' });
  assertReply(await f.submit(otherManual), otherManual, 'rejected', { reason: 'manual_restart_pending' }, false);
  const upgrade = { version: 1, type: 'restart_all', requestId: 'upgrade-after-manual', reason: 'upgrade' };
  assert.deepEqual((await f.submit(upgrade)).reply, { version: 1, type: 'restart_all', requestId: upgrade.requestId, ok: false, code: 'manual_restart_pending' });
  const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
  db.setDrainFence(mode === 'single' ? '*' : 'origin', { reason: 'manual_restart', runId: 'other-run' });
  const fenceBefore = db.listDrainFences();
  let state = await m4.command('tick'); assert.deepEqual(state.requests, accepted); assert.deepEqual(state.stopped, []); assert.deepEqual(db.listDrainFences(), fenceBefore);
  f.db.exec('DELETE FROM drain_fences');
  state = await m4.command('tick'); assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []); assert.equal(state.scene.present, false);
  await m4.stop();
});

for (const mode of ['single', 'multi']) test(`${mode} real Origin appearing during target observation requires refresh, never auto-selects`, { timeout: 25000 }, async t => {
  const f = fixture(t, mode); f.tmux('kill-session', '-t', '=zylos-group-origin');
  const m4 = launch(t, f); assert.equal((await m4.next()).ready, true); await m4.command('arm-read');
  const req = manual('appearing-target'), pending = f.submit(req);
  assert.deepEqual(await m4.next(), { barrier: 'reading-target' });
  f.tmux('new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=appeared', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', ...(mode === 'multi' ? ['-e', 'ZYLOS_SESSION_GROUP=origin'] : []), path.join(f.root, 'claude'), '120');
  await m4.command('release-read'); assertReply(await pending, req, 'rejected', { reason: 'target_required' }, false);
  const state = await assertUntouched(m4, f); assert.equal(state.scene.runId, 'appeared'); await m4.stop();
});

for (const mode of ['single', 'multi']) test(`${mode} actual tmux server restart and reused Origin name cannot redirect accepted intent`, { timeout: 25000 }, async t => {
  const f = fixture(t, mode), m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  const req = manual('server-replaced', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'accepted');
  f.tmux('kill-server'); await f.waitForServerExit();
  f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=replacement', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', ...(mode === 'multi' ? ['-e', 'ZYLOS_SESSION_GROUP=origin'] : []), path.join(f.root, 'claude'), '120');
  f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
  fs.writeFileSync(f.readyPath, JSON.stringify({ ...f.ready, runId: 'replacement', sessionId: 'replacement-session' }));
  const state = await m4.command('tick'); assert.equal(state.scene.runId, 'replacement'); assert.equal(state.scene.present, true);
  assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []); assert.deepEqual(state.stopped, []);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await m4.stop();
});

for (const runtime of ['claude', 'codex']) test(`${runtime} stopping Origin leaves real ready ordinary runtime and its ledger untouched`, { timeout: 25000 }, async t => {
  const f = fixture(t, 'multi', runtime), group = 'fixture:ordinary', name = tmuxNameForGroup(group);
  const directory = groupRunDir(group, f.env); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'current-session.json'), JSON.stringify({ runId: 'ordinary-run', sessionId: 'ordinary-session', ts: 1, startupControlIds: [] }));
  f.tmux('new-session', '-d', '-s', name, '-e', 'ZYLOS_RUN_ID=ordinary-run', '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify({ runtime, mode: 'default' })}`, path.join(f.root, runtime), '120');
  const pid = f.tmux('display-message', '-p', '-t', `${name}:`, '#{pane_pid}');
  f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture','ordinary pending','pending',?)").run(group);
  const before = f.db.prepare('SELECT * FROM conversations').all();
  const m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  const req = manual('only-origin', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'accepted');
  const state = await m4.command('tick'); assert.equal(state.scene.present, false); assert.equal(state.stopped.length, 1); assert.equal(state.stopped[0].runId, 'run-1');
  assert.equal(f.tmux('display-message', '-p', '-t', `${name}:`, '#{pane_pid}'), pid);
  assert.equal(f.tmux('show-environment', '-t', `=${name}`, 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=ordinary-run');
  assert.deepEqual(f.db.prepare('SELECT * FROM conversations').all(), before); await m4.stop();
});


// Boundary: real supervisor entry targets one ordinary tmux run and retains its
// SQLite fence/F9 while that group's own delivery is inflight. Run for manual
// admission/execution/target changes; skip unrelated lifecycle work. Fresh
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, private socket/database and fixture
// processes only; no live tmux/network. Child/service and fixture resources close.
test('actual supervisor manual restart targets ordinary group while Origin and another group survive', { timeout: 25000 }, async t => {
  const f = fixture(t), group = 'fixture:a', other = 'fixture:b';
  f.env.PM2_HOME = path.join(f.root, 'pm2'); f.env.TMPDIR = path.join(f.root, 'tmp');
  fs.mkdirSync(f.env.TMPDIR); f.env.TMUX_TMPDIR = f.root; delete f.env.TMUX;
  console.log(JSON.stringify({ HOME: f.env.HOME, ZYLOS_DIR: f.env.ZYLOS_DIR, PM2_HOME: f.env.PM2_HOME,
    TMPDIR: f.env.TMPDIR, TMUX_TMPDIR: f.env.TMUX_TMPDIR, TMUX: f.env.TMUX ?? null, socket: f.socketPath,
    database: path.join(f.root, 'comm-bridge/c4.db') }));
  assert.ok(f.root.startsWith('/tmp/')); assert.ok(Buffer.byteLength(f.socketPath) < 100);
  const put = (key, runId) => {
    const dir = groupRunDir(key, f.env); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current-session.json'), JSON.stringify({ runId, sessionId: runId, ts: Date.now(), startupControlIds: [] }));
    f.tmux('new-session', '-d', '-s', tmuxNameForGroup(key), '-e', `ZYLOS_RUN_ID=${runId}`, '-e', `ZYLOS_SESSION_GROUP=${key}`,
      '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', path.join(f.root, 'claude'), '120');
  };
  put(group, 'run-a'); put(other, 'run-b');
  const m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture','inflight','running',?)").run(group);
  const req = manual('ordinary', { sessionGroup: group, expectedRunId: 'run-a' });
  assertReply(await f.submit(req), req, 'accepted');
  let state = await m4.command('tick');
  assert.equal(state.scene.present, true); assert.equal(state.scene.runId, 'run-1');
  assert.deepEqual(state.stopped.map(row => row.runId), ['run-a']);
  assert.equal(state.fences[0].sessionGroup, group); assert.equal(state.fences[0].reason, 'manual_restart');
  assert.equal(state.requests[0].sessionGroup, group);
  assert.equal(f.tmux('show-environment', '-t', `=${tmuxNameForGroup(other)}`, 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=run-b');
  f.db.prepare("UPDATE conversations SET status='delivered' WHERE session_group=?").run(group);
  state = await m4.command('tick');
  assert.deepEqual(state.fences, []); assert.deepEqual(state.requests, []);
  const events = fs.readFileSync(path.join(f.root, 'activity-monitor/supervisor-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.event === 'manual_restart_done' && event.session_group === group));
  await m4.stop();
});


async function healthGuardFixture(t, mode = 'multi') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-health-'));
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: root };
  delete env.TMUX;
  fs.mkdirSync(env.TMPDIR);
  fs.mkdirSync(path.join(root, 'activity-monitor'));
  const sqlite = new Database(':memory:');
  guardDatabase(sqlite, schema);
  const config = { mode, runtime: 'claude', capacity: 4 };
  const store = createStore(sqlite, { readConfig: () => ({ state: 'ok', config: { session_mode: mode, runtime: 'claude' } }) });
  const requestStore = new RestartRequestStore({ file: path.join(root, 'activity-monitor/restart-requests.json') });
  const stopped = [], controls = [];
  const groups = mode === 'single' ? ['origin'] : ['fixture:a', 'fixture:b', 'origin'];
  const scenes = new Map(groups.map((sessionGroup, i) => {
    const runDir = groupRunDir(sessionGroup, env);
    fs.mkdirSync(runDir, { recursive: true });
    return [sessionGroup, { sessionGroup, runtime: 'claude', runId: `run-${i}`, sessionId: `session-${i}`,
      present: true, ready: true, processRunning: true, state: 'idle', idleSince: 0, runDir }];
  }));
  const snapshot = () => [...scenes.values()].map(scene => ({ ...scene }));
  const supervisor = createSupervisor({ env, zylosDir: root, now: () => 1000000,
    db: { ...store, insertControl: (content, options) => { controls.push({ content, ...options }); return { id: controls.length }; } },
    scenes: { observe: async () => snapshot(),
      readIdentity: async group => ({ ...scenes.get(group) }), observeGroup: async group => ({ ...scenes.get(group) }),
      bindTarget: async scene => ({ sessionGroup: scene.sessionGroup, expectedRunId: scene.runId }),
      stop: async scene => { stopped.push(scene.sessionGroup); Object.assign(scenes.get(scene.sessionGroup), { present: false, ready: false, processRunning: false }); },
      listRuns: async () => [], readRun: async group => ({ ...scenes.get(group) }) },
    requestStore, readMode: () => ({ mode }), readConfiguration: () => config,
    resolveTargetRuntime: () => 'claude', readSyncMarker: () => ({ held: false, stale: false }),
    prompts: {}, checkAuth: async () => ({ status: 'success' }),
    loopOptions: { schedule: () => assert.fail('fixture must not start a background loop'), cancel() {} }, log() {},
  });
  t.after(async () => { await supervisor.stop(); sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(root.startsWith(process.env.TMPDIR + path.sep));
  assert.notEqual(root, process.env.HOME);
  console.log(JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME,
    TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, TMUX: env.TMUX ?? null, database: ':memory:', tmux: 'not used' }));
  await supervisor.loop.deps.readConfiguration(null);
  return { root, env, supervisor, store, requestStore, stopped, controls, scenes, snapshot, config,
    pendingA: () => requestStore.write([{ requestId: 'pending-a', reason: 'manual_restart', acceptedAt: 1,
      runIds: ['run-0'], mode: 'multi', expectedRunId: 'run-0', sessionGroup: 'fixture:a' }]) };
}

for (const action of ['stop', 'nudge']) {
  // Boundary: actual supervisor composition wires health actions through the
  // manual-request guard and fresh scene identity. Run for health/manual mutex
  // changes; skip unrelated lifecycle work. Runner-isolated HOME/ZYLOS_DIR/
  // PM2_HOME/short TMPDIR, private F9/health files and in-memory SQLite; terminal
  // providers are fixtures, no tmux/PM2/network/child process. No loop is started;
  // supervisor and DB close before the fixture root is removed, including failure.
  test(`health guard ${action} preserves ordinary actions with corrupt restart requests and blocks Origin`, { timeout: 2000 }, async t => {
    const f = await healthGuardFixture(t);
    fs.writeFileSync(f.requestStore.file, '{damaged');
    const act = scene => action === 'stop' ? f.supervisor.observer.stop(scene) : f.supervisor.observer.nudge(scene, async () => true);
    const result = await act(f.scenes.get('fixture:a'));
    assert.equal(action === 'stop' ? result : result.ok, true);
    assert.equal(f.stopped.length, action === 'stop' ? 1 : 0);
    assert.equal(f.controls.length, action === 'nudge' ? 2 : 0);
    if (action === 'nudge') {
      assert.deepEqual(f.controls.map(control => ({ group: control.sessionGroup, content: control.content })), [
        { group: 'fixture:a', content: '[KEYSTROKE]Escape' },
        { group: 'fixture:a', content: 'continue' },
      ]);
    }
    await assert.rejects(act(f.scenes.get('origin')), { code: 'requests_unreadable' });
    assert.equal(f.scenes.get('origin').present, true);
    assert.equal(f.stopped.includes('origin'), false);
    assert.equal(f.controls.some(control => control.sessionGroup === 'origin'), false);
    assert.equal(fs.readFileSync(f.requestStore.file, 'utf8'), '{damaged');
  });

  // Boundary: actual health stop/nudge guards match the pending manual row's
  // target before any side effect. Run for group-target mutex changes; skip
  // unrelated lifecycle work. Fresh runner HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR,
  // private F9/health files, in-memory SQLite and fixture terminal providers only;
  // no tmux, services, network or children. Stop supervisor/DB then clean fixture.
  test(`health guard ${action} blocks the pending manual target while other groups and Origin proceed`, { timeout: 2000 }, async t => {
    const f = await healthGuardFixture(t); f.pendingA();
    const act = scene => action === 'stop' ? f.supervisor.observer.stop(scene) : f.supervisor.observer.nudge(scene, async () => true);
    const blocked = await act(f.scenes.get('fixture:a'));
    assert.equal(action === 'stop' ? blocked : blocked.ok, false);
    assert.equal(f.stopped.length, 0); assert.equal(f.controls.length, 0);
    for (const group of ['fixture:b', 'origin']) {
      const result = await act(f.scenes.get(group));
      assert.equal(action === 'stop' ? result : result.ok, true);
    }
    if (action === 'stop') assert.deepEqual(f.stopped, ['fixture:b', 'origin']);
    else assert.deepEqual(f.controls.map(control => ({ group: control.sessionGroup, content: control.content })), [
      { group: 'fixture:b', content: '[KEYSTROKE]Escape' }, { group: 'fixture:b', content: 'continue' },
      { group: 'origin', content: '[KEYSTROKE]Escape' }, { group: 'origin', content: 'continue' },
    ]);
    assert.equal(f.scenes.get('fixture:a').present, true);
    assert.equal(f.requestStore.read()[0].sessionGroup, 'fixture:a');
  });
}

// Boundary: real auth-recovery maintenance selects targets, writes SQLite auth
// fences through lifecycle, and reclaims only the unblocked Origin. Run for auth
// recovery/manual mutex changes; skip unrelated lifecycle work. Runner-isolated
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; private F9/health files, in-memory SQLite,
// injected terminal providers, no tmux/PM2/network/children. No background loop;
// supervisor and database close before removing only the fixture's directory.
test('auth recovery skips the pending manual group and reclaims Origin', { timeout: 2000 }, async t => {
  const f = await healthGuardFixture(t); f.pendingA();
  const healthStore = f.supervisor.health.store('claude'), state = healthStore.read();
  state.health = 'auth_failed'; state.reason = 'authentication_failed'; healthStore.write(state);
  const targets = [f.scenes.get('fixture:a'), f.scenes.get('origin')];
  assert.equal(await f.supervisor.health.beginAuthRecovery('claude', { status: 'success' }, targets), true);
  await f.supervisor.loop.deps.writeMetricsAndMaintain({ configuration: f.config, scenes: f.snapshot(), fences: [] });
  assert.equal(f.store.getDrainFence('fixture:a'), null);
  const fence = f.store.getDrainFence('origin');
  assert.equal(fence.reason, 'auth'); assert.equal(fence.runId, 'run-2');
  const context = { configuration: f.config, transition: null, restartRequests: f.requestStore.read(),
    scenes: f.snapshot(), fences: f.store.listDrainFences() };
  assert.equal(await f.supervisor.lifecycle.advanceReclaim(fence, context), 'done');
  assert.deepEqual(f.stopped, ['origin']);
  assert.equal(f.scenes.get('fixture:a').present, true);
  assert.equal(f.store.getDrainFence('origin'), null);
  assert.equal(f.requestStore.read()[0].sessionGroup, 'fixture:a');
});


for (const mode of ['multi', 'single']) {
  // Boundary: real health guards interpret omitted multi targets and single
  // intent as Origin. Run for manual target/default/mode guard changes; skip
  // unrelated lifecycle changes. Fresh runner HOME/ZYLOS_DIR/PM2_HOME/short
  // TMPDIR, private F9 and in-memory SQLite; no tmux, services, network or
  // children. No loop starts; fixture closes supervisor/DB before root cleanup.
  test(`health guard preserves Origin with an ungrouped ${mode} manual intent`, { timeout: 2000 }, async t => {
    const f = await healthGuardFixture(t, mode);
    const origin = f.scenes.get('origin');
    const request = { requestId: 'pending-origin', reason: 'manual_restart', acceptedAt: 1,
      runIds: [origin.runId], mode, expectedRunId: origin.runId };
    f.requestStore.write([request]);
    assert.equal(Object.hasOwn(f.requestStore.read()[0], 'sessionGroup'), false);
    assert.equal(await f.supervisor.observer.stop(origin), false);
    assert.equal((await f.supervisor.observer.nudge(origin, async () => true)).ok, false);
    assert.equal(f.stopped.length, 0); assert.equal(f.controls.length, 0);
    assert.equal(f.scenes.get('origin').present, true);
    assert.deepEqual(f.requestStore.read(), [request]);
  });
}

// Boundary: real maintenance preserves a single manual intent while auth
// recovery is active. Run for auth/manual mode guards; skip unrelated lifecycle
// work. Fresh runner HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, private F9/health files
// and in-memory SQLite; no tmux, services, network, children or background loop.
// Fixture stops supervisor and closes DB before removing only its own root.
test('auth recovery preserves the running single manual target', { timeout: 2000 }, async t => {
  const f = await healthGuardFixture(t, 'single');
  const origin = f.scenes.get('origin');
  const request = { requestId: 'pending-single', reason: 'manual_restart', acceptedAt: 1,
    runIds: [origin.runId], mode: 'single', expectedRunId: origin.runId };
  f.requestStore.write([request]);
  const healthStore = f.supervisor.health.store('claude'), state = healthStore.read();
  state.health = 'auth_failed'; state.reason = 'authentication_failed'; healthStore.write(state);
  assert.equal(await f.supervisor.health.beginAuthRecovery('claude', { status: 'success' }, [origin]), true);
  assert.equal(f.supervisor.health.authRecoveries.has('claude'), true);
  await f.supervisor.loop.deps.writeMetricsAndMaintain({ configuration: f.config, scenes: f.snapshot(), fences: [] });
  assert.equal(f.stopped.length, 0); assert.equal(f.controls.length, 0);
  assert.equal(f.scenes.get('origin').present, true);
  assert.equal(f.scenes.get('origin').processRunning, true);
  assert.equal(f.scenes.get('origin').runId, origin.runId);
  assert.deepEqual(f.requestStore.read(), [request]);
});
