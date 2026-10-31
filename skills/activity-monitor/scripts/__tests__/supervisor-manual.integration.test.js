import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { RestartRequestStore } from '../restart-request-store.js';
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
// DM / supervisor: real crash windows with durable intent + SQLite gate.
// The Origin name plus runId is the target; renamed runs and replacements survive.
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
