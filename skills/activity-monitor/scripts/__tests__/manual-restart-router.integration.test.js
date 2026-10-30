import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, launch, manual, assertReply } from './fixtures/manual-restart-harness.js';
import { tmuxNameForGroup, groupRunDir } from '../../../../cli/lib/session-group-paths.js';
const worker = fileURLToPath(new URL('./fixtures/manual-restart-router-worker.js', import.meta.url));
async function m1(t, f, scenario) {
  const child = fork(worker, [f.root, f.socketPath, f.binary, f.mode, scenario], { env: { ...process.env, ...f.env }, silent: true });
  let sequence = 0, stderr = '', readyResolve, readyReject, barrierResolve;
  const pending = new Map(), barriers = [];
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stderr.on('data', data => stderr += data); child.stdout.on('data', data => stderr += data);
  child.on('message', message => {
    if (message.ready) return readyResolve();
    if (message.barrier) { if (barrierResolve) { const resolve = barrierResolve; barrierResolve = null; resolve(message); } else barriers.push(message); return; }
    const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
  });
  child.on('exit', (code, signal) => { const error = new Error(`launcher exited ${code ?? signal}: ${stderr}`); readyReject(error); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } });
  await ready;
  const call = op => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`launcher ${op} timeout: ${stderr}`)); }, 10000); pending.set(id, { resolve, reject, timer }); child.send({ id, op }); });
  return { call, barrier: () => barriers.length ? Promise.resolve(barriers.shift()) : new Promise(resolve => { barrierResolve = resolve; }),
    async stop() { const done = once(child, 'exit'); await call('stop'); assert.equal((await done)[0], 0); } };
}
function trace(f) { const file = path.join(f.root, 'manual-router.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function requests(f) { const file = path.join(f.root, 'activity-monitor/restart-requests.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; }
async function until(check, describe) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); } assert.fail(describe()); }
for (const mode of ['single', 'multi']) test(`${mode} real launcher paste in flight, real supervisor manual kill retains gate until late bound Enter settles`, { timeout: 30000 }, async t => realInflight(t, mode));
async function realInflight(t, mode, variant = '') {
  const f = fixture(t, mode), m4 = launch(t, f, variant); assert.equal((await m4.next()).ready, true);
  const router = await m1(t, f, 'inflight');
  const id = f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture','OLD_PASTE_ONLY','pending',?)").run(mode === 'single' ? '' : 'origin').lastInsertRowid;
  for (let i = 0; i < 5; i++) await router.call('tick');
  const boundary = await router.barrier(); assert.deepEqual(boundary, { barrier: 'after-real-paste', runId: 'run-1' });
  assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').pluck().get(id), 'running');
  assert.equal(trace(f).filter(row => row.kind === 'paste').length, 1);
  const req = manual('real-inflight', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'accepted');
  const accepted = requests(f), stopped = await m4.command('tick');
  assert.equal(stopped.scene.present, false); assert.equal(stopped.fences.length, 1, 'real in-flight launcher must retain manual D8'); assert.deepEqual(stopped.requests, accepted);
  assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').pluck().get(id), 'running');
  // A new object at the same name cannot receive delayed Enter from the old claim.
  f.tmux('new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=replacement', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', ...(mode === 'multi' ? ['-e', 'ZYLOS_SESSION_GROUP=origin'] : []), path.join(f.root, 'claude'), '120');
  fs.writeFileSync(f.readyPath, JSON.stringify({ ...f.ready, runId: 'replacement', sessionId: 'new-session' }));
  await router.call('release'); await router.call('drain');
  assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').pluck().get(id), 'pending');
  assert.equal(f.db.prepare('SELECT retry_count FROM conversations WHERE id=?').pluck().get(id), 0);
  assert.deepEqual(trace(f).filter(row => row.kind === 'keys-attempt').map(row => row.runId), ['run-1']);
  assert.deepEqual(trace(f).filter(row => row.kind === 'keys-sent'), []);
  assert.equal(trace(f).filter(row => row.kind === 'paste').length, 1);
  const done = await m4.command('tick'); assert.deepEqual(done.requests, []); assert.deepEqual(done.fences, []); assert.equal(done.scene.runId, 'replacement');
  assert.equal(f.tmux('capture-pane', '-p', '-t', 'zylos-group-origin:').includes('OLD_PASTE_ONLY'), false);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
  t.diagnostic(JSON.stringify({ mode, boundary, accounted: f.db.prepare('SELECT status,retry_count FROM conversations WHERE id=?').get(id), delayedKeys: trace(f).filter(row => row.kind.startsWith('keys-')), finalRun: done.scene.runId }));
  await router.stop(); await m4.stop();
}
test('real launcher in-flight oracle: detects early supervisor removal', { timeout: 30000 }, async t => {
  await assert.rejects(realInflight(t, 'multi', 'early-clear'), { code: 'ERR_ASSERTION', message: /real in-flight launcher must retain manual D8/ });
});

for (const mode of ['single', 'multi']) test(`${mode} real launcher replacement startup failure cannot restore completed manual intent or gate`, { timeout: 30000 }, async t => {
  const f = fixture(t, mode); let ordinary;
  if (mode === 'multi') {
    const group = 'fixture:ordinary', name = tmuxNameForGroup(group), dir = groupRunDir(group, f.env); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current-session.json'), JSON.stringify({ runId: 'ordinary', sessionId: 'ordinary-session', ts: 1, startupControlIds: [] }));
    f.tmux('new-session', '-d', '-s', name, '-e', 'ZYLOS_RUN_ID=ordinary', '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', path.join(f.root, 'claude'), '120');
    ordinary = { name, pid: f.tmux('display-message', '-p', '-t', `${name}:`, '#{pane_pid}') };
  }
  const m4 = launch(t, f); assert.equal((await m4.next()).ready, true); const router = await m1(t, f, 'launch-failure');
  const req = manual('restart-then-fail', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'accepted');
  const stopped = await m4.command('tick'); assert.equal(stopped.scene.present, false); assert.deepEqual(stopped.requests, []); assert.deepEqual(stopped.fences, []);
  await until(async () => { await router.call('tick'); await router.call('drain'); return (await router.call('state')).resident.failures > 0; }, () => JSON.stringify(trace(f)));
  const attempts = trace(f).filter(row => row.kind === 'launch'); assert.ok(attempts.length > 0);
  assert.ok(attempts.every(row => row.input.sessionGroup === (mode === 'single' ? null : 'origin')));
  assert.ok(trace(f).some(row => row.kind === 'launch-error' || row.event === 'launch_failed' || row.event === 'ready_timeout'), JSON.stringify(trace(f)));
  t.diagnostic(JSON.stringify({ mode, attempts, failures: trace(f).filter(row => row.kind === 'launch-error' || row.event === 'launch_failed' || row.event === 'ready_timeout'), resident: (await router.call('state')).resident }));
  const final = await m4.command('tick'); assert.deepEqual(final.requests, []); assert.deepEqual(final.fences, []);
  assert.equal(JSON.parse(fs.readFileSync(f.readyPath, 'utf8')).runId, 'run-1');
  if (ordinary) { assert.equal(f.tmux('display-message', '-p', '-t', `${ordinary.name}:`, '#{pane_pid}'), ordinary.pid); assert.equal(f.tmux('show-environment', '-t', `=${ordinary.name}`, 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=ordinary'); }
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await router.stop(); await m4.stop();
});
