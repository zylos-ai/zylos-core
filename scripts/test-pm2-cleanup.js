import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function listPm2Daemons() {
  return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+PM2 .+: God Daemon \((.+)\)\s*$/);
      return match ? [{ pid: Number(match[1]), home: match[2] }] : [];
    });
}

function inside(root, home) {
  const relative = path.relative(root, path.resolve(home));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stopDaemon(root, home) {
  assert(inside(root, home), 'Refusing PM2 cleanup outside test root');
  // Resolve existing ancestors as well, including homes deleted by a test.
  let ancestor = home;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const realRoot = fs.realpathSync(root);
  assert(inside(realRoot, fs.realpathSync(ancestor)) || fs.realpathSync(ancestor) === realRoot,
    'Refusing PM2 cleanup through a symlink outside test root');
  if (fs.existsSync(path.join(home, 'rpc.sock'))) {
    try {
      execFileSync('pm2', ['kill'], {
        env: { ...process.env, PM2_HOME: home }, timeout: 10000, stdio: 'pipe',
      });
    } catch { /* Fall back to the verified owned PID if its socket is stale. */ }
  }
  for (const daemon of listPm2Daemons().filter(daemon => daemon.home === home)) {
    try { process.kill(daemon.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

// Process titles retain PM2_HOME even after an individual test deletes it.
// Enumerating them also catches nested homes instead of only home/.pm2.
export function cleanupTestPm2(root, { list = listPm2Daemons, stop = stopDaemon, attempts = 40 } = {}) {
  root = path.resolve(root);
  const owned = () => list().filter(daemon => inside(root, daemon.home));
  for (const home of new Set(owned().map(daemon => daemon.home))) {
    try {
      stop(root, home);
    } catch {
      // A daemon can exit between enumeration and kill. The exit guard below
      // decides success from remaining processes, not the PM2 CLI status.
    }
  }
  let remaining = owned();
  for (let attempt = 0; remaining.length && attempt < attempts; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    remaining = owned();
  }
  assert.equal(remaining.length, 0,
    `Test runner leaked PM2 daemons: ${remaining.map(({ pid, home }) => `${pid} (${home})`).join(', ')}`);
}
