import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as schema from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';
import { createCoreObserver } from '../c4-runtime-observer.js';

const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
function fixture(t, { runtimeProcess = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-observer-'));
  const old = { ZYLOS_DIR: process.env.ZYLOS_DIR, ZYLOS_PACKAGE_ROOT: process.env.ZYLOS_PACKAGE_ROOT };
  process.env.ZYLOS_DIR = root; process.env.ZYLOS_PACKAGE_ROOT = packageRoot;
  const socketPath = path.join(root, 'tmux.sock');
  const tmux = (...args) => execFileSync('tmux', ['-S', socketPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const runtime = path.join(root, 'claude');
  if (runtimeProcess) {
    fs.writeFileSync(path.join(root, 'fixture.c'), '#include <unistd.h>\nint main(void) { sleep(120); return 0; }\n');
    execFileSync('cc', [path.join(root, 'fixture.c'), '-o', runtime]);
  }
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin',
    '-e', 'ZYLOS_RUN_ID=run-1', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',
    runtimeProcess ? runtime : '/bin/sleep', '120');
  const readyPath = path.join(root, 'activity-monitor/session-groups/origin/current-session.json');
  fs.mkdirSync(path.dirname(readyPath), { recursive: true });
  const ready = { runId: 'run-1', sessionId: 'session-1', ts: 1, startupControlIds: [] };
  fs.writeFileSync(readyPath, JSON.stringify(ready));
  t.after(() => {
    try { tmux('kill-server'); } catch {}
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, tmux, readyPath, ready, observer: createCoreObserver({ tmux: { socketPath } }) };
}

test('Core module loading retries after failure and caches success', async t => {
  const { root, tmux, ready } = fixture(t);
  // A fresh module keeps this regression independent of other observer calls.
  const { createCoreObserver: createFreshObserver } = await import('../c4-runtime-observer.js?retry-test');
  const observer = createFreshObserver({ tmux: { socketPath: path.join(root, 'tmux.sock') } });
  const incomplete = path.join(root, 'incomplete-core');
  fs.mkdirSync(path.join(incomplete, 'cli/lib'), { recursive: true });
  fs.writeFileSync(path.join(incomplete, 'cli/lib/config.js'), '');
  process.env.ZYLOS_PACKAGE_ROOT = incomplete;
  await assert.rejects(observer.observeCoreTarget({ sessionMode: 'single' }), { code: 'ERR_MODULE_NOT_FOUND' });
  process.env.ZYLOS_PACKAGE_ROOT = packageRoot;
  const result = await observer.observeCoreTarget({ sessionMode: 'single' });
  assert.equal(result.runId, 'run-1');
  assert.deepEqual(result.currentSession, ready);
  process.env.ZYLOS_PACKAGE_ROOT = incomplete;
  assert.deepEqual(await observer.observeCoreTarget({ sessionMode: 'single' }), result);
  assert.equal(tmux('list-clients', '-F', '#{client_pid}'), '');
});

test('async target observer returns exact real tmux identity and READY', async t => {
  const { observer, tmux, ready } = fixture(t);
  const pending = observer.observeCoreTarget({ sessionMode: 'single' });
  assert.equal(typeof pending.then, 'function');
  const result = await pending;
  assert.equal(result.runId, 'run-1'); assert.equal(result.runtime, 'claude');
  assert.equal(result.sessionGroup, undefined); assert.deepEqual(result.currentSession, ready);
  assert.deepEqual(result.tmuxTarget, {
    serverGeneration: tmux('display-message', '-p', '#{pid}:#{start_time}'),
    sessionId: tmux('display-message', '-p', '-t', '=zylos-group-origin:', '#{session_id}'),
    paneId: tmux('display-message', '-p', '-t', '=zylos-group-origin:', '#{pane_id}'),
  });
  assert.equal(tmux('list-clients', '-F', '#{client_pid}'), '');
});

test('F2 launch intent alone cannot claim a live runtime process', async t => {
  const { observer } = fixture(t);
  const running = await observer.observeCoreRunning({ sessionGroup: 'origin', sessionMode: 'single' });
  assert.equal(running.hasProcess, false);
  assert.equal(running.identityVerified, true); assert.equal(running.ready, true);
  assert.deepEqual(running.launchConfig, { runtime: 'claude', mode: 'default' });
});

test('real process observation, malformed READY and scope identity are distinct', async t => {
  const { observer, tmux, readyPath } = fixture(t, { runtimeProcess: true });
  let running = await observer.observeCoreRunning({ sessionGroup: 'origin', sessionMode: 'single' });
  assert.equal(running.hasProcess, true); assert.equal(running.identityVerified, true);
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{"runtime":"codex","mode":"default"}');
  assert.equal((await observer.observeCoreRunning({ sessionGroup: 'origin', sessionMode: 'single' })).identityVerified, false);
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{"runtime":"claude","mode":"default"}');
  fs.writeFileSync(readyPath, '{}');
  running = await observer.observeCoreRunning({ sessionGroup: 'origin', sessionMode: 'single' });
  assert.equal(running.hasProcess, true); assert.equal(running.ready, false);
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_SESSION_GROUP', 'other');
  assert.equal((await observer.observeCoreRunning({ sessionGroup: 'origin', sessionMode: 'multi' })).identityVerified, false);
  assert.equal((await observer.observeCoreTarget({ sessionGroup: 'origin', sessionMode: 'multi' })).sessionGroup, 'other');
});

test('missing run stays observable for ordered builder validation; absent differs from transport error', async t => {
  const { observer, tmux, root } = fixture(t);
  tmux('set-environment', '-u', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID');
  assert.equal((await observer.observeCoreTarget({ sessionMode: 'single' })).runId, null);
  assert.equal(await observer.observeCoreTarget({ sessionGroup: 'other', sessionMode: 'multi' }), null);
  tmux('kill-server');
  assert.equal(await observer.observeCoreTarget({ sessionMode: 'single' }), null);
  assert.deepEqual(await observer.observeCoreRunning({ sessionMode: 'single' }), { hasProcess: false });
  const broken = createCoreObserver({ tmux: { binary: path.join(root, 'missing-tmux') } });
  await assert.rejects(() => broken.observeCoreTarget({ sessionMode: 'single' }), { code: 'TMUX_UNAVAILABLE' });
});


// Keep this test compatible with the previous synchronous implementation so the
// same assertion is a negative control: its blocked event loop cannot tick.
test('frozen private tmux observation leaves the caller timer responsive', async t => {
  const { observer, tmux } = fixture(t);
  const server = Number(tmux('display-message', '-p', '#{pid}'));
  assert.ok(Number.isSafeInteger(server) && server > 0);
  let pending = true, ticksWhilePending = 0, firstTickMs;
  const started = performance.now();
  const timer = setInterval(() => {
    if (pending) {
      ticksWhilePending++;
      firstTickMs ??= performance.now() - started;
    }
  }, 100);
  let failure;
  try {
    process.kill(server, 'SIGSTOP');
    try { await observer.observeCoreTarget({ sessionMode: 'single' }); }
    catch (error) { failure = error; }
    finally { pending = false; clearInterval(timer); }
    assert.equal(failure?.code, 'TMUX_UNAVAILABLE');
    assert.equal(failure?.cause, 'timeout');
    assert.ok(ticksWhilePending > 0, 'caller timer never fired while observation was pending');
    assert.match(execFileSync('ps', ['-o', 'stat=', '-p', String(server)], { encoding: 'utf8' }).trim(), /^T/);
    t.diagnostic(JSON.stringify({ firstTickMs, ticksWhilePending, elapsedMs: performance.now() - started, code: failure.code }));
  } finally {
    pending = false;
    clearInterval(timer);
    // Resume before fixture teardown tries to send kill-server to this socket.
    try { process.kill(server, 'SIGCONT'); } catch {}
  }
});

for (const json of [false, true]) for (const mode of ['single', 'multi']) test(`production control CLI and builder use real isolated tmux (${mode}, json=${json})`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-binding-live-'));
  const env = { PATH: process.env.PATH, HOME: root, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: packageRoot, TMUX_TMPDIR: root, LANG: 'en_US.UTF-8' };
  const tmux = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: mode }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge/c4.db')); guardDatabase(db, schema); db.pragma('journal_mode=WAL');
  const readyPath = path.join(root, 'activity-monitor/session-groups/origin/current-session.json');
  fs.mkdirSync(path.dirname(readyPath), { recursive: true });
  const ready = { runId: 'run-1', sessionId: 'session-1', ts: 1, startupControlIds: [] };
  fs.writeFileSync(readyPath, JSON.stringify(ready));
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin',
    '-e', 'ZYLOS_RUN_ID=run-1', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',
    ...(mode === 'multi' ? ['-e', 'ZYLOS_SESSION_GROUP=origin'] : []), '/bin/sleep', '120');
  t.after(() => { try { tmux('kill-server'); } catch {} db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const args = ['enqueue', '--content', 'fixture control', '--no-ack-suffix', '--target-run', 'run-1', '--expected-runtime', 'claude', '--expected-session', 'session-1', ...(mode === 'multi' ? ['--group', 'origin'] : [])];
  const cli = (extra = [], expected) => {
    const out = spawnSync(process.execPath, [fileURLToPath(new URL('../c4-control.js', import.meta.url)), ...args, ...(json ? ['--json'] : []), ...extra], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(out.status, expected ? 1 : 0, `${out.stdout}\n${out.stderr}\n${out.error ?? ''}`);
    if (json) {
      assert.equal(out.stderr, '');
      assert.equal(out.stdout.trim().split('\n').length, 1);
      const response = JSON.parse(out.stdout);
      assert.equal(response.ok, !expected);
      if (expected) {
        assert.equal(response.error.code, expected);
        assert.deepEqual(response.error.persisted, []);
      }
    } else if (expected) assert.match(out.stderr, new RegExp(`\\[${expected}\\]`));
    return out;
  };
  const success = cli();
  const row = db.prepare('SELECT * FROM control_queue').get();
  assert.equal(row.session_group, mode === 'multi' ? 'origin' : null);
  const binding = JSON.parse(row.target_binding);
  if (json) assert.deepEqual(JSON.parse(success.stdout), { ok: true, data: { id: row.id, supersededCount: 0, targetBinding: binding } });
  assert.equal(binding.expectedRunId, 'run-1'); assert.equal(binding.expectedSessionId, 'session-1');
  assert.equal(binding.tmuxTarget.serverGeneration, tmux('display-message', '-p', '#{pid}:#{start_time}'));
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{');
  cli([], 'TARGET_SNAPSHOT_UNKNOWN');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{"runtime":"codex","mode":"default"}');
  cli([], 'TARGET_RUNTIME_MISMATCH');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_MODEL_CONFIG', '{"runtime":"claude","mode":"default"}');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'run-2');
  const mismatch = cli([], 'TARGET_MISMATCH');
  if (json) assert.equal(JSON.parse(mismatch.stdout).error.runId, 'run-2');
  else assert.match(mismatch.stderr, /run-2/);
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'run-1');
  tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_SESSION_GROUP', 'other');
  cli([], 'TARGET_SCOPE_MISMATCH');
  if (mode === 'multi') tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_SESSION_GROUP', 'origin');
  else tmux('set-environment', '-u', '-t', '=zylos-group-origin', 'ZYLOS_SESSION_GROUP');
  fs.writeFileSync(readyPath, JSON.stringify({ ...ready, runId: 'old-run' })); cli([], 'TARGET_NOT_READY');
  fs.writeFileSync(readyPath, JSON.stringify({ ...ready, sessionId: 'new-session' })); cli([], 'STALE_TARGET');
  tmux('kill-server'); cli([], 'TARGET_NOT_RUNNING');
  assert.deepEqual(db.prepare('SELECT * FROM control_queue').all(), [row]);
});
