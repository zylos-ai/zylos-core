import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function listPm2Daemons({
  exec = execFileSync, readFile = fs.readFileSync, platform = process.platform,
  uid = process.getuid(),
} = {}) {
  const snapshot = () => exec('ps', ['-eo', 'uid=,pid=,stat=,args='], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(PM2 .*: God Daemon(?: \(.*)?)\s*$/);
    if (!match || Number(match[1]) !== uid || /^[ZX]/.test(match[3])) return [];
    return [{ pid: Number(match[2]), title: match[4] }];
  });
  return snapshot().flatMap(({ pid, title }) => {
    if (platform !== 'linux') {
      const home = title.match(/^PM2 .+: God Daemon \((.+)\)\s*$/)?.[1];
      assert(home && path.isAbsolute(home), `Cannot verify PM2 daemon ${pid}: PM2_HOME unavailable or truncated`);
      return [{ pid, home }];
    }
    // argv-backed titles can truncate PM2_HOME. The initial environment
    // retains the full path even after a test deletes the home directory.
    for (let attempt = 0; attempt < 2; attempt++) {
      let failure;
      try {
        const environment = readFile(`/proc/${pid}/environ`, 'utf8');
        const home = environment.split('\0').find(entry => entry.startsWith('PM2_HOME='))?.slice(9);
        assert(home && path.isAbsolute(home), `Cannot verify PM2 daemon ${pid}: PM2_HOME unavailable or truncated`);
        return [{ pid, home }];
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return [];
        failure = error;
      }
      // Exit-to-zombie can produce EACCES, just like a live unreadable process.
      // Recheck after EACH failed read, including the last, before failing closed.
      if (!snapshot().some(candidate => candidate.pid === pid)) return [];
      if (attempt === 1) {
        if (failure.code === 'ERR_ASSERTION') throw failure;
        throw new Error(`Cannot verify PM2 daemon ${pid}: environment unreadable (${failure.code ?? 'unknown'})`, { cause: failure });
      }
    }
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

// Process metadata survives deletion of an individual test home.
// Enumerating daemons also catches nested homes instead of only home/.pm2.
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
