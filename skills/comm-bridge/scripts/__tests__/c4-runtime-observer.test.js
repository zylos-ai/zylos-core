import {readyTmuxTarget} from '../../../../test/helpers/ready-tmux-target.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCoreObserver } from '../c4-runtime-observer.js';

const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
function fixture(t, { runtimeProcess = false } = {}) {
  const f=readyTmuxTarget(t,{prefix:'c4-observer-',runtimeProcess,ledger:false,packageRoot});
  const old = { ZYLOS_DIR: process.env.ZYLOS_DIR, ZYLOS_PACKAGE_ROOT: process.env.ZYLOS_PACKAGE_ROOT };
  process.env.ZYLOS_DIR=f.root;process.env.ZYLOS_PACKAGE_ROOT=packageRoot;
  t.after(()=>{for(const [key,value] of Object.entries(old)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  return {...f,observer:createCoreObserver({tmux:{socketPath:f.socketPath,binary:f.binary}})};
}

test('Core module loading retries after failure and caches success', async t => {
  const { root, tmux, ready, binary } = fixture(t);
  // A fresh module keeps this regression independent of other observer calls.
  const { createCoreObserver: createFreshObserver } = await import('../c4-runtime-observer.js?retry-test');
  const observer = createFreshObserver({ tmux: { socketPath: path.join(root, 'tmux.sock'), binary } });
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
  const {env,tmux,db,readyPath,ready}=readyTmuxTarget(t,{prefix:'c4-binding-live-',mode,packageRoot});
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

for (const phase of ['runtime-process', 'final-revalidation']) test(`post-observation ${phase} command failure maps to TMUX_UNAVAILABLE`, async t => {
  const {root,binary:requestedBinary} = fixture(t);
  const binary = execFileSync('sh', ['-c', 'command -v "$1"', 'sh', requestedBinary], {encoding:'utf8'}).trim();
  const wrapper = path.join(root, 'tmux-error-wrapper');
  const count = path.join(root, 'environment-reads');
  // Initial observation uses configured F2. Inject failure only at the later
  // process probe or third environment read (the observer's final revalidation).
  fs.writeFileSync(wrapper, `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), action = args.join(' ');
let reads = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8')) : 0;
if (action.includes('show-environment')) fs.writeFileSync(${JSON.stringify(count)}, String(++reads));
if (${JSON.stringify(phase)} === 'runtime-process' ? action.includes('#{pane_pid}') : reads === 3) {
  process.stdout.write('ZYLOS_OK\\n'); process.stderr.write('injected command failure\\n'); process.exit(1);
}
const result = cp.spawnSync(${JSON.stringify(binary)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`, {mode:0o700});
  const observer = createCoreObserver({tmux:{socketPath:path.join(root,'tmux.sock'), binary:wrapper}});
  const method = phase === 'runtime-process' ? 'observeCoreRunning' : 'observeCoreTarget';
  await assert.rejects(observer[method]({sessionMode:'single'}), {code:'TMUX_UNAVAILABLE', cause:'error'});
  assert.equal(Number(fs.readFileSync(count, 'utf8')), phase === 'runtime-process' ? 2 : 3);
});
