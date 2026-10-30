import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
const worker = fileURLToPath(new URL('./fixtures/supervisor-reclaim-worker.js', import.meta.url));
function start(f, pause) {
  const child = spawn(process.execPath, [worker, path.join(f.root, 'comm-bridge/c4.db'), f.socketPath, f.binary, pause],
    { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const exited = once(child, 'exit');
  const message = Promise.race([once(child, 'message').then(([value]) => value), exited.then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
  return { child, exited, message };
}
// real process termination at the three durable recovery boundaries.
// Uses actual SQLite + isolated tmux + adapter.stop, with an exited-runtime fixture.
for (const pause of ['after-fence', 'before-stop', 'after-stop']) {
  test(`reclaim resumes after SIGKILL ${pause} using durable fence and actual target`, { timeout: 15000 }, async t => {
    const f = readyTmuxTarget(t, { prefix: 'supervisor-reclaim-', mode: 'multi' });
    f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
    const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
    db.setDrainFence('origin', { reason: 'upgrade', runId: 'run-1' });
    const first = start(f, pause); t.after(() => { if (first.child.exitCode === null) first.child.kill('SIGKILL'); });
    assert.deepEqual(await first.message, { barrier: pause });
    first.child.kill('SIGKILL'); await first.exited;
    assert.equal(db.getDrainFence('origin').runId, 'run-1');
    const second = start(f, ''); t.after(() => { if (second.child.exitCode === null) second.child.kill('SIGKILL'); });
    assert.deepEqual(await second.message, { result: 'done' });
    assert.equal((await second.exited)[0], 0); assert.equal(db.getDrainFence('origin'), null);
    assert.throws(() => f.tmux('has-session', '-t', '=zylos-group-origin'));
    assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
  });
}

// acceptance oracle: dropping persisted cannot pass the same
// completion assertion, and leaves the real original target stranded.
test('reclaim recovery harness detects restart that clears durable fence', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-reclaim-bad-', mode: 'multi' });
  const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  db.setDrainFence('origin', { reason: 'upgrade', runId: 'run-1' });
  const first = start(f, 'after-fence');
  t.after(() => { if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL'); });
  assert.deepEqual(await first.message, { barrier: 'after-fence' });
  first.child.kill('SIGKILL'); await first.exited;
  const bad = start(f, 'mutant-clear-fence');
  t.after(() => { if (bad.child.exitCode === null && bad.child.signalCode === null) bad.child.kill('SIGKILL'); });
  await assert.rejects(async () => assert.deepEqual(await bad.message, { result: 'done' }), /Cannot read properties of null.*reason/s);
  assert.equal((await bad.exited)[0], 1);
  assert.equal(db.getDrainFence('origin'), null);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=zylos-group-origin'));
});
