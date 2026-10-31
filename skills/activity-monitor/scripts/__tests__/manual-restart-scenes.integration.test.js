import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { fixture, launch, manual, assertReply } from './fixtures/manual-restart-harness.js';
import { tmuxNameForGroup, groupRunDir } from '../../../../cli/lib/session-group-paths.js';

const requestFile = f => path.join(f.root, 'activity-monitor/restart-requests.json');
async function assertUntouched(m4, f) {
  const state = await m4.command('state');
  assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []); assert.deepEqual(state.stopped, []);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
  return state;
}
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

for (const mode of ['single', 'multi']) test(`${mode} manual restart stops busy Sync-held run despite running control, retains until inflight accounted`, { timeout: 25000 }, async t => {
  await inflight(t, mode);
});
async function inflight(t, mode, variant = '') {
  const f = fixture(t, mode), m4 = launch(t, f, variant); assert.equal((await m4.next()).ready, true);
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
  assert.deepEqual(f.db.prepare('SELECT * FROM control_queue').all(), control);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await m4.stop();
}
test('oracle: early gate withdrawal is detected by the same real supervisor inflight assertion', { timeout: 25000 }, async t => {
  await assert.rejects(inflight(t, 'single', 'early-clear'), { code: 'ERR_ASSERTION', message: /manual inflight intent must persist/ });
});

for (const mode of ['single', 'multi']) for (const pause of ['before-intent', 'after-intent', 'after-fence', 'after-stop', 'after-clear', 'before-remove', 'after-remove']) {
  test(`${mode} full supervisor SIGKILL ${pause} recovers durable intent without resubmission or retargeting`, { timeout: 25000 }, async t => {
    await crashWindow(t, mode, pause);
  });
}
async function crashWindow(t, mode, pause, variant = '') {
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
  const second = launch(t, f, variant), state = await second.next(); assert.equal(state.ready, true);
  assert.equal(state.scene.present, true, 'replacement must remain present'); assert.equal(state.scene.runId, 'replacement'); assert.deepEqual(state.stopped, []);
  assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []);
  if (beforeStop) assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-original'));
  const done = await second.command('tick'); assert.deepEqual(done.stopped, []); assert.deepEqual(done.requests, []);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await second.stop();
}
test('oracle: retargeting recovered intent kills replacement and fails the same survival assertion', { timeout: 25000 }, async t => {
  await assert.rejects(crashWindow(t, 'multi', 'after-intent', 'retarget'), { code: 'ERR_ASSERTION', message: /replacement must remain present/ });
});

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
