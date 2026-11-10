import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export function createPrivateFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'i-')));
  const env = {
    PATH: process.env.PATH, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'),
    ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    ...(process.env.TEST_TMUX_BIN ? { TEST_TMUX_BIN: process.env.TEST_TMUX_BIN } : {}),
  };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key]);
  assert.notEqual(env.ZYLOS_DIR, fs.realpathSync(process.env.ZYLOS_DIR), 'child must not use the shared runner instance');
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.equal(fs.realpathSync(env[key]), env[key]);
    assert.equal(path.dirname(env[key]), root);
  }
  assert.ok(Buffer.byteLength(path.join(env.TMPDIR, 'tm-XXXXXX/s')) < 100, 'private tmux socket must be short');
  const remove = () => fs.rmSync(root, { recursive: true, force: true });
  // Safety fallback runs after the caller's explicit cleanup assertion.
  t.after(remove);
  return { root, env, remove };
}

export async function runPrivateFixture(scope, file, args = [], { nodeTest = false, timeout = 10000 } = {}) {
  const { env } = scope;
  console.log('private fixture isolation', JSON.stringify({ file, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
    PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR,
    socket: path.join(env.TMPDIR, 'tm-XXXXXX/s'),
    database: path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db'), pm2: 'not started' }));
  const child = spawn(process.execPath, [...(nodeTest ? ['--test'] : []), file, ...args], {
    env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', bytes = 0, failure, launchError;
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const collect = data => {
    bytes += data.length;
    if (bytes > 65536) { failure ??= 'fixture output exceeded 65536 bytes'; stop(); return; }
    output += data.toString();
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const completion = new Promise(resolve => {
    child.once('error', error => { launchError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => { failure ??= 'fixture deadline exceeded'; stop(); }, timeout);
  try {
    const result = await completion;
    if (output) console.log(output.trimEnd());
    assert.equal(launchError, undefined);
    assert.equal(failure, undefined, output);
    assert.equal(result.code, 0, output || `fixture exited with ${result.signal}`);
  } finally {
    clearTimeout(deadline);
    stop();
    await completion;
  }
}

// tmux daemonizes outside the child group; only this fixture's socket can be
// targeted if the child is killed before its own after-hook runs.
export function stopPrivateTmux({ env }) {
  const names = fs.readdirSync(env.TMPDIR).filter(name => name.startsWith('tm-'));
  assert.ok(names.length <= 1, 'the boundary fixture owns one tmux server');
  for (const name of names) {
    try { execFileSync(env.TEST_TMUX_BIN || 'tmux', ['-S', path.join(env.TMPDIR, name, 's'), 'kill-server'], {
      env, timeout: 1000, stdio: 'ignore',
    }); } catch (error) { if (error.status !== 1) throw error; }
  }
}
