import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

export const MARKER_TTL_MS = 1800000;
import { memoryError, reportMemoryError, isMain, options, runCli } from './sync-cli.js';
export { memoryError, reportMemoryError } from './sync-cli.js';

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
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
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

export function markerPath(runDir, kind) {
  if (!['group', 'origin', 'global'].includes(kind)) throw memoryError('INVALID_INPUT', 'Invalid Sync kind');
  return path.join(runDir, kind === 'origin' ? 'origin-sync.lock' : 'sync.lock');
}

export function readMarker(runDir, kind, warn = message => process.stderr.write(`${message}\n`)) {
  let value;
  try { value = JSON.parse(fs.readFileSync(markerPath(runDir, kind), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { marker: null, reason: 'missing' };
    warn(`Warning: unreadable Sync marker: ${error.message}`);
    return { marker: null, reason: 'invalid' };
  }
  if (!value || typeof value.runId !== 'string' || !value.runId || !['group', 'origin', 'global'].includes(value.kind) ||
      !/^[0-9a-f]{32}$/.test(value.token || '') ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) {
    warn('Warning: invalid Sync marker');
    return { marker: null, reason: 'invalid' };
  }
  return { marker: value, reason: null };
}

export function readSyncMarker({ runDir, kind, currentRunId }, { now = Date.now, warn } = {}) {
  const { marker, reason } = readMarker(runDir, kind, warn);
  if (!marker) return { held: false, stale: false, runId: null, expiresAt: null, reason };
  const expired = now() >= marker.expiresAt;
  const stale = marker.runId !== currentRunId || expired;
  return { held: !stale, stale, runId: marker.runId, expiresAt: marker.expiresAt,
    reason: marker.runId !== currentRunId ? 'run_changed' : expired ? 'expired' : 'held' };
}

export async function memoryScope(env = process.env) {
  const coreDir = path.dirname(resolveCoreConfigModule());
  const paths = await import(pathToFileURL(path.join(coreDir, 'session-group-paths.js')).href);
  const run = paths.runDirFromEnv(env);
  return { ...run, runDir: paths.groupRunDir(run.sessionGroup || 'origin', env), root: paths.zylosRoot(env),
    memoryDir: run.sessionGroup ? paths.groupMemoryDir(run.sessionGroup, env) : path.join(paths.zylosRoot(env), 'memory'),
    runId: env.ZYLOS_RUN_ID || null, scope: run.sessionGroup || '*' };
}

function checkKind(scope, kind) {
  markerPath(scope.runDir, kind);
  if (!scope.runId || (kind === 'global' ? scope.kind !== 'single' : scope.kind !== 'group') ||
      (kind === 'origin' && scope.sessionGroup !== 'origin')) throw memoryError('SCOPE_UNBOUND', 'Sync kind does not match the running scope');
}

export async function readCurrentRunId(scope, { tmux } = {}) {
  const coreDir = path.dirname(resolveCoreConfigModule());
  const [{ openTmuxConnection }, { observeSessionTarget }] = await Promise.all([
    import(pathToFileURL(path.join(coreDir, 'runtime/tmux-connection.js')).href),
    import(pathToFileURL(path.join(coreDir, 'runtime/session-target.js')).href),
  ]);
  let connection;
  try {
    connection = await openTmuxConnection(tmux);
    const target = await observeSessionTarget({ sessionGroup: scope.sessionGroup, connection,
      readReady: async () => null, readProcessTree: async () => [] });
    return target.present ? target.runId : null;
  } catch (error) {
    if (error.code === 'TMUX_NO_SERVER') return null;
    throw error;
  } finally { connection?.close(); }
}

export async function acquire({ kind, env = process.env, waitMs }, { currentRunId = readCurrentRunId, now = Date.now } = {}) {
  const scope = await memoryScope(env);
  checkKind(scope, kind);
  return withMemoryLock(scope.runDir, async () => {
    const liveRun = await currentRunId(scope);
    if (liveRun !== scope.runId) throw memoryError('SCOPE_UNBOUND', 'Running session identity no longer matches');
    if (readSyncMarker({ runDir: scope.runDir, kind, currentRunId: liveRun }, { now }).held) {
      throw memoryError('SYNC_BUSY', 'Sync is already running');
    }
    const token = randomBytes(16).toString('hex');
    const startedAt = now();
    const marker = { runId: scope.runId, kind, token, startedAt, expiresAt: startedAt + MARKER_TTL_MS };
    const target = markerPath(scope.runDir, kind);
    const temp = `${target}.${token}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(marker) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
    return token;
  }, { waitMs });
}

export async function release({ kind, token, env = process.env, waitMs }) {
  const scope = await memoryScope(env);
  checkKind(scope, kind);
  if (!/^[0-9a-f]{32}$/.test(token || '')) throw memoryError('INVALID_INPUT', 'Invalid Sync token');
  return withMemoryLock(scope.runDir, () => {
    const { marker } = readMarker(scope.runDir, kind);
    if (marker?.token === token) fs.unlinkSync(markerPath(scope.runDir, kind));
  }, { waitMs });
}

/** All guarded mutations check ownership and execute in the same F8 section. */
export async function guard({ kind, token, env = process.env, waitMs }, action) {
  const scope = await memoryScope(env);
  const defaultKind = scope.kind === 'group' ? 'group' : 'global';
  checkKind(scope, kind === 'auto' ? defaultKind : kind ?? defaultKind);
  if (!/^[0-9a-f]{32}$/.test(token || '')) throw memoryError('TOKEN_MISMATCH', 'Sync token is missing or invalid');
  return withMemoryLock(scope.runDir, () => {
    const kinds = kind === 'auto' && scope.sessionGroup === 'origin'
      ? ['group', 'origin'] : [kind === 'auto' ? defaultKind : kind ?? defaultKind];
    const marker = kinds.map(candidate => readMarker(scope.runDir, candidate).marker)
      .find((marker, i) => marker && marker.token === token && marker.kind === kinds[i]);
    if (!marker || marker.runId !== scope.runId) throw memoryError('TOKEN_MISMATCH', 'Sync ownership no longer matches');
    return action({ ...scope, marker });
  }, { waitMs });
}

export async function status({ group, env = process.env } = {}, { currentRunId = readCurrentRunId } = {}) {
  const scope = await memoryScope(group === undefined ? env : { ...env, ZYLOS_SESSION_GROUP: group });
  const liveRun = await currentRunId(scope);
  const kind = scope.kind === 'group' ? 'group' : 'global';
  const result = { sync: readSyncMarker({ runDir: scope.runDir, kind, currentRunId: liveRun }) };
  if (scope.sessionGroup === 'origin') result.origin = readSyncMarker({ runDir: scope.runDir, kind: 'origin', currentRunId: liveRun });
  return result;
}

if (isMain(import.meta.url)) await runCli(async () => {
  const [command, ...args] = process.argv.slice(2);
  const values = options(args, ['kind', 'token', 'group'], ['json']);
  if (values.positional.length) throw memoryError('INVALID_INPUT', 'Unexpected positional arguments');
  if (command === 'status' && !values.kind && !values.token) {
    process.stdout.write(JSON.stringify(await status(values), null, values.json ? 0 : 2) + '\n');
  } else if (command === 'acquire' && !values.group && !values.token && !values.json) {
    process.stdout.write(await acquire(values) + '\n');
  } else if (command === 'release' && !values.group && !values.json) await release(values);
  else throw memoryError('INVALID_INPUT', 'Invalid Sync lock command');
});
