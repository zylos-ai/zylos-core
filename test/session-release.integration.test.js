import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from './helpers/ready-tmux-target.js';

// Boundary: real requestRelease client/socket -> startSupervisor admission and
// lifecycle -> real C4 SQLite ending/slot transaction and run-guarded tmux stop.
// Sync execution is represented by the real claim/ack APIs; no model, channel
// send, PM2 service or authenticated runtime is started. Cold incoming demand is
// checked through actual C4 group routing and slot admission, not model launch.
// Known unresolved boundary: self-invocation runs under pre_tool busy state; the
// Origin case demonstrates that rejection, then tests an already idle requester.
// These cases do not establish end-to-end usability of self-invoked release.
// Run for release admission, lifecycle, ending/slot or Sync-order changes.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR. Every case owns a
// private database, socket, named native sleeper runtime and worker. Cleanup
// waits for or kills the worker, closes SQLite and kills only its tmux server.
const worker = fileURLToPath(new URL('./helpers/session-release-worker.js', import.meta.url));
for (const [group, sync] of [['origin', 'clean'], ['telegram:release', 'clean'], ['telegram:release', 'sync']]) {
  test(`voluntary ${group} release (${sync}) ends its exact run and leaves cold inbound eligible`, { timeout: 30000 }, async t => {
    const realHome = fs.realpathSync(os.userInfo().homedir);
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
      assert.ok(process.env[key] && !path.resolve(process.env[key]).startsWith(realHome + path.sep), `${key} must be isolated`);
    }
    let child;
    // Register worker cleanup before the fixture's database/tmux cleanup, so a
    // timeout cannot remove resources while a worker still uses them.
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await stopped;
      }
    });
    const f = readyTmuxTarget(t, { prefix: 'release-', mode: 'multi', runtimeProcess: true });
    f.tmux('new-session', '-d', '-s', 'fixture-keeper', '/bin/sleep', '120');
    child = fork(worker, [f.socketPath, f.binary, group, sync], { env: { ...process.env, ...f.env }, silent: true });
    let stderr = '', result;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.on('message', message => { result = message; });
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(status, 0, stderr); assert.equal(result?.ok, true, stderr);
    assert.equal(result.ending.reason, 'release');
    assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
  });
}
