import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateConfigStore } from './config-store.js';

const HELPER = fileURLToPath(new URL('./config-lock-helper.js', import.meta.url));
export const CONFIG_LOCK_FALLBACK_WARNING = 'Warning: config lock unavailable; using atomic write without concurrency protection.\n';

function executableOnPath(command, envPath = process.env.PATH || '') {
  for (const directory of envPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
function lockTimeout(message = 'Timed out waiting for the config lock') {
  const error = new Error(message);
  error.code = 'CONFIG_LOCK_TIMEOUT';
  return error;
}
function restoreError(data) {
  const error = new Error(data.message || 'Config update failed');
  for (const key of ['code', 'phase', 'persisted', 'stack']) {
    if (data[key] !== undefined) error[key] = data[key];
  }
  return error;
}

function parseHelperResult(child) {
  if (child.error) throw child.error;
  const text = String(child.stdout || '').trim();
  if (!text) return null;
  let message;
  try { message = JSON.parse(text); }
  catch { throw new Error(`Invalid config helper response: ${text.slice(0, 200)}`); }
  if (message.ok) return message.result;
  throw restoreError(message.error || {});
}

function remainingWait(waitMs, deadlineAt, now = Date.now()) {
  const requested = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 2000;
  if (deadlineAt === undefined || deadlineAt === null) return requested;
  return Math.max(0, Math.min(requested, Number(deadlineAt) - now));
}

function linuxCapability({ env = process.env, existsSync = fs.existsSync } = {}) {
  const flock = executableOnPath('flock', env.PATH);
  if (!flock || !existsSync('/proc/self/fd')) return null;
  return { backend: 'linux-flock', executable: flock };
}

const PERL_LOCK_SCRIPT = String.raw`
use strict; use warnings; use Fcntl qw(:flock F_SETFD); use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC sleep);
my $wait_ms = shift @ARGV; open(my $lock, '<&=3') or exit 73;
my $deadline = clock_gettime(CLOCK_MONOTONIC) + ($wait_ms / 1000);
while (!flock($lock, LOCK_EX | LOCK_NB)) { exit 75 if clock_gettime(CLOCK_MONOTONIC) >= $deadline; sleep(0.01); }
fcntl($lock, F_SETFD, 0) or exit 73; exec @ARGV; exit 73;
`;

function macCapability({ spawn = spawnSync, existsSync = fs.existsSync } = {}) {
  const perl = '/usr/bin/perl';
  if (!existsSync(perl)) return null;
  const probe = spawn(perl, ['-MFcntl=:flock,F_SETFD', '-MTime::HiRes=clock_gettime,CLOCK_MONOTONIC,sleep', '-e', 'exit 0'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) return null;
  return { backend: 'macos-perl', executable: perl };
}

export function detectConfigLockCapability({ platform = process.platform, ...deps } = {}) {
  if (platform === 'linux') return linuxCapability(deps);
  if (platform === 'darwin') return macCapability(deps);
  return null;
}

export function updateConfigWithLock({ configFile, lockFile, update, waitMs = 2000, deadlineAt }, {
  capability = detectConfigLockCapability(),
  spawn = spawnSync,
  openSync = fs.openSync,
  closeSync = fs.closeSync,
  mkdirSync = fs.mkdirSync,
  writeStderr = (message) => process.stderr.write(message),
  fallbackStore = updateConfigStore,
  now = Date.now,
} = {}) {
  const budget = remainingWait(waitMs, deadlineAt, now());
  if (budget <= 0) throw lockTimeout();
  if (!capability) {
    writeStderr(CONFIG_LOCK_FALLBACK_WARNING);
    return fallbackStore(configFile, update);
  }

  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const lockFd = openSync(lockFile, 'a', 0o600);
  let child;
  try {
    const common = [process.execPath, HELPER];
    const args = capability.backend === 'linux-flock'
      ? ['--exclusive', '--no-fork', '--conflict-exit-code', '75', '--timeout', String(budget / 1000), '/proc/self/fd/3', ...common]
      : ['-e', PERL_LOCK_SCRIPT, String(budget), ...common];
    child = spawn(capability.executable, args, {
      input: JSON.stringify({ configFile, update }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe', lockFd],
      env: process.env,
    });
  } finally {
    closeSync(lockFd);
  }

  const result = parseHelperResult(child);
  if (result) return result;
  if (child.status === 75) throw lockTimeout();
  if (child.status === 0 || child.signal) {
    const error = new Error('Config writer result was lost; commit state is unknown');
    error.code = 'CONFIG_WRITE_UNKNOWN';
    error.phase = 'unknown';
    error.persisted = null;
    error.signal = child.signal;
    throw error;
  }
  const detail = String(child.stderr || '').trim();
  const error = new Error(`Config lock helper failed${detail ? `: ${detail}` : ''}`);
  error.code = 'CONFIG_LOCK_FAILED';
  error.status = child.status;
  error.signal = child.signal;
  throw error;
}
