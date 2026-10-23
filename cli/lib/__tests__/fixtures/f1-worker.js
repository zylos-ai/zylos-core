import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const READY = 'F1_LOCK_READY\n';
const SELF = fileURLToPath(import.meta.url);
const HELPER = fileURLToPath(new URL('../../config-lock-helper.js', import.meta.url));
const CRASH_WORKER = fileURLToPath(new URL('./f1-crash-store.js', import.meta.url));
const PERL_LOCK_SCRIPT = String.raw`
use strict; use warnings; use Fcntl qw(:flock F_SETFD); use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC sleep);
my $force_fail = shift @ARGV; my $wait_ms = shift @ARGV; open(my $lock, '<&=3') or exit 73;
exit 73 if $force_fail eq '1';
my $deadline = clock_gettime(CLOCK_MONOTONIC) + ($wait_ms / 1000);
while (!flock($lock, LOCK_EX | LOCK_NB)) { exit 75 if clock_gettime(CLOCK_MONOTONIC) >= $deadline; sleep(0.01); }
fcntl($lock, F_SETFD, 0) or exit 73; exec @ARGV; exit 73;
`;

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

function runAction(payload) {
  fs.writeSync(1, READY);
  if (payload.holdMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, payload.holdMs);
  const child = payload.crashAt
    ? spawnSync(process.execPath, [CRASH_WORKER, JSON.stringify(payload)], { encoding: 'utf8' })
    : spawnSync(process.execPath, [HELPER], {
      input: JSON.stringify({ configFile: payload.configFile, update: payload.update }),
      encoding: 'utf8',
    });
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exit(child.status ?? 1);
}

async function runHolder(payload) {
  fs.mkdirSync(path.dirname(payload.lockFile), { recursive: true });
  const fd = fs.openSync(payload.lockFile, 'a', 0o600);
  let executable;
  let args;
  let backend;
  if (process.platform === 'linux') {
    executable = executableOnPath('flock');
    backend = 'linux-flock';
    if (executable) {
      const lockTarget = payload.fixtureLockFailure ? '/proc/self/fd/invalid' : '/proc/self/fd/3';
      args = [
        '--exclusive', '--no-fork', '--conflict-exit-code', '75', '--timeout', '2',
        lockTarget, process.execPath, SELF, JSON.stringify(payload), '--locked',
      ];
    }
  } else if (process.platform === 'darwin') {
    executable = fs.existsSync('/usr/bin/perl') ? '/usr/bin/perl' : null;
    backend = 'macos-perl';
    if (executable) {
      args = [
        '-e', PERL_LOCK_SCRIPT, payload.fixtureLockFailure ? '1' : '0', '2000',
        process.execPath, SELF, JSON.stringify(payload), '--locked',
      ];
    }
  } else {
    backend = `unsupported-${process.platform}`;
  }

  if (!executable) {
    fs.closeSync(fd);
    fs.writeSync(2, `CONFIG_TEST_LOCK_UNAVAILABLE: ${backend}\n`);
    process.exit(3);
  }

  let child;
  try {
    child = spawn(executable, args, { stdio: ['ignore', 'inherit', 'inherit', fd] });
  } finally {
    fs.closeSync(fd);
  }
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const { status, signal } = await new Promise(resolve => {
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  if (spawnError || status !== 0) {
    const detail = spawnError ? `${spawnError.code || spawnError.name}: ${spawnError.message}` : `status=${status} signal=${signal || 'none'}`;
    fs.writeSync(2, `CONFIG_TEST_LOCK_FAILED: ${backend} ${detail}\n`);
  }
  process.exit(status ?? 1);
}

const payload = JSON.parse(process.argv[2]);
if (process.argv[3] === '--locked') runAction(payload);
if (payload.crashAt || Object.hasOwn(payload, 'holdMs')) await runHolder(payload);
try {
  const { updateConfigWithLock } = await import('../../config-lock.js');
  process.stdout.write(JSON.stringify(updateConfigWithLock(payload)));
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exit(2);
}
