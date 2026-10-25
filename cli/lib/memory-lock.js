import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configLockArgs, detectConfigLockCapability } from './config-lock.js';

const SELF = fileURLToPath(import.meta.url);
const failure = (code, message) => Object.assign(new Error(message), { code, persisted: [] });

/** Fixed-inode F8; closing the lock holder is confirmed before returning. */
export async function withMemoryLock(runDir, action, { waitMs = 10000 } = {}) {
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 10000) throw failure('INVALID_INPUT', 'Invalid lock wait');
  const capability = detectConfigLockCapability();
  if (!capability) throw failure('LOCK_UNAVAILABLE', 'Kernel memory locking is unavailable');
  const lockPath = path.join(runDir, 'memory.lock');
  let fd;
  try {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  } catch (cause) { throw failure('LOCK_UNAVAILABLE', cause.message); }
  const inode = fs.fstatSync(fd);
  if (!inode.isFile()) { fs.closeSync(fd); throw failure('LOCK_UNAVAILABLE', 'Memory lock is not a file'); }
  let child;
  try {
    child = spawn(capability.executable, configLockArgs(capability, waitMs, [process.execPath, SELF, '--hold-lock']),
      { stdio: ['pipe', 'pipe', 'pipe', fd] });
  } finally { fs.closeSync(fd); }
  child.stdin.on('error', () => {});
  let ready = false, output = '', startupError;
  const closed = new Promise(resolve => {
    child.once('error', error => { startupError = error; });
    child.once('close', code => resolve(code));
  });
  const acquired = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!ready && output === 'locked\n') { ready = true; resolve(); }
    });
    closed.then(code => {
      if (!ready) reject(failure(code === 75 ? 'LOCK_TIMEOUT' : 'LOCK_UNAVAILABLE', startupError?.message || 'Memory lock acquisition failed'));
    });
  });
  child.stderr.resume();
  const assertHeld = () => {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      const cause = failure('LOCK_LOST', 'Memory lock holder exited during the operation');
      cause.persisted = null;
      throw cause;
    }
  };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(failure('LOCK_TIMEOUT', 'Memory lock acquisition timed out'));
    }, waitMs + 1000);
  });
  try {
    await Promise.race([acquired, deadline]);
    clearTimeout(timer);
    try {
      const current = fs.lstatSync(lockPath);
      if (!current.isFile() || current.dev !== inode.dev || current.ino !== inode.ino) throw Error('Memory lock inode changed');
    } catch (cause) { throw failure('LOCK_UNAVAILABLE', cause.message); }
    assertHeld();
    const result = await action(assertHeld);
    assertHeld();
    return result;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (!ready && child.exitCode === null) child.kill('SIGKILL');
    await closed;
  }
}

if (process.argv[1] === SELF && process.argv[2] === '--hold-lock') {
  process.stdout.write('locked\n');
  process.stdin.resume();
}
