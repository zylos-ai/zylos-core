import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { memoryError } from './sync-cli.js';

// The child only acquires a lock on an inherited descriptor. It exits before
// the callback starts; the parent retains the same open-file description.
const PERL_ACQUIRE = String.raw`
use strict; use warnings; use Fcntl qw(:flock); use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC sleep);
my $wait_ms = shift @ARGV; open(my $lock, '<&=3') or exit 73;
my $deadline = clock_gettime(CLOCK_MONOTONIC) + ($wait_ms / 1000);
while (!flock($lock, LOCK_EX | LOCK_NB)) { exit 75 if clock_gettime(CLOCK_MONOTONIC) >= $deadline; sleep(0.005); }
exit 0;
`;

/** Fixed-inode kernel lock. The callback and retained lock fd live together. */
export async function withMemoryLock(runDir, action, { waitMs = 10000 } = {}) {
  if (typeof runDir !== 'string' || !runDir || typeof action !== 'function' ||
      !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 10000) {
    throw memoryError('INVALID_INPUT', 'Invalid memory lock arguments');
  }
  if (!['linux', 'darwin'].includes(process.platform)) throw memoryError('LOCK_UNAVAILABLE', 'Kernel memory locking is unavailable');
  if (waitMs === 0) throw memoryError('LOCK_TIMEOUT', 'Memory lock acquisition timed out');
  const started = performance.now();
  const lockPath = path.join(runDir, 'memory.lock');
  let fd;
  try {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    try { fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (['EISDIR', 'ELOOP'].includes(error.code)) throw memoryError('LOCK_UNAVAILABLE', 'Memory lock is not a regular file');
      throw error;
    }
    const inode = fs.fstatSync(fd);
    if (!inode.isFile()) throw memoryError('LOCK_UNAVAILABLE', 'Memory lock is not a regular file');
    const remaining = waitMs - (performance.now() - started);
    if (remaining <= 0) throw memoryError('LOCK_TIMEOUT', 'Memory lock acquisition timed out');
    await new Promise((resolve, reject) => {
      const executable = process.platform === 'linux' ? 'flock' : '/usr/bin/perl';
      const args = process.platform === 'linux'
        ? ['--exclusive', '--timeout', String(remaining / 1000), '--conflict-exit-code', '75', '3']
        : ['-e', PERL_ACQUIRE, String(remaining)];
      const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', fd] });
      let failure, diagnostic = '';
      const cancel = () => {
        failure ??= memoryError('LOCK_TIMEOUT', 'Memory lock acquisition timed out');
        child.kill('SIGKILL');
      };
      const timer = setTimeout(cancel, remaining);
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2048); });
      child.on('error', cause => { failure ??= memoryError('LOCK_UNAVAILABLE', cause.message); });
      // Reap before closing the inherited fd or rejecting; a late acquisition
      // can never run the callback after timeout.
      child.on('close', code => {
        clearTimeout(timer);
        if (performance.now() - started >= waitMs || code === 75) {
          failure ??= memoryError('LOCK_TIMEOUT', 'Memory lock acquisition timed out');
        }
        if (!failure && code !== 0) failure = memoryError('LOCK_UNAVAILABLE', diagnostic.trim() || 'Kernel lock acquisition failed');
        failure ? reject(failure) : resolve();
      });
    });
    return await action();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
