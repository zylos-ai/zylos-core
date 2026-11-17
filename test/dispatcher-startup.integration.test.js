import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { cleanupTestPm2 } from '../scripts/test-pm2-cleanup.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(root, 'skills/comm-bridge/scripts/c4-dispatcher.js');
const fixture = fileURLToPath(new URL('./fixtures/dispatcher-startup.js', import.meta.url));
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const reapers = new WeakMap();

function environment(t) {
  reapers.set(t, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-exit-'));
  const env = { ...process.env, HOME: path.join(dir, 'h'), ZYLOS_DIR: path.join(dir, 'z'),
    PM2_HOME: path.join(dir, 'p'), TMPDIR: path.join(dir, 't'), TMUX_TMPDIR: path.join(dir, 't'),
    ZYLOS_PACKAGE_ROOT: root, C4_DISPATCHER_DISABLE_MAIN: '0',
    DISPATCHER_FIXTURE_RESULT: path.join(dir, 'result.json') };
  delete env.TMUX;
  for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    fs.mkdirSync(env[name]);
    assert.equal(fs.realpathSync(env[name]), env[name]);
    assert.ok(env[name].startsWith(dir + path.sep));
  }
  assert.ok(Buffer.byteLength(path.join(env.PM2_HOME, 'rpc.sock')) < 100);
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), '{"session":{"mode":"multi"}}');
  t.diagnostic(JSON.stringify({ entry, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
    PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, tmuxSocket: path.join(env.TMUX_TMPDIR, `tmux-${process.getuid()}`, 'default'),
    database: path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db') }));
  t.after(async () => {
    for (const reap of reapers.get(t)) await reap();
    cleanupTestPm2(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return env;
}

function launch(t, env, args = []) {
  const child = spawn(process.execPath, [...args, entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  reapers.get(t).push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stderr.resume();
    await closed;
  });
  let out = '', err = '';
  const append = (previous, chunk) => {
    assert.ok(previous.length + chunk.length <= 2 * 1024 * 1024, 'bounded child output');
    return previous + chunk;
  };
  child.stdout.on('data', chunk => { out = append(out, chunk); });
  return { child, closed, stdout: () => out, stderr: () => err,
    readErrors() { child.stderr.on('data', chunk => { err = append(err, chunk); }); } };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(30); }
  assert.fail('dispatcher condition timed out');
}

// Boundary: real entry/main/SQLite, injected factory failures and a held handle.
// Run for startup-exit or error-output changes; skip unrelated delivery changes.
for (const mode of ['create', 'start']) {
  test(`${mode} failure flushes a backpressured stack and exits with a held handle`, { timeout: 10000 }, async t => {
    const env = { ...environment(t), DISPATCHER_FIXTURE_MODE: mode };
    const p = launch(t, env, ['--no-warnings', '--experimental-test-module-mocks', '--import', fixture]);
    await delay(200);
    assert.equal(p.child.exitCode, null, 'stderr pipe must drain before exit');
    p.readErrors();
    const [code, signal] = await p.closed;
    assert.equal(code, 1); assert.equal(signal, null);
    const expected = 'Dispatcher startup error: Error: fixture startup failed\n';
    assert.ok(p.stderr().includes(expected));
    assert.ok(p.stderr().endsWith('stack-frame '.repeat(65536) + '\nEND-OF-STACK\n'));
    const result = JSON.parse(fs.readFileSync(env.DISPATCHER_FIXTURE_RESULT));
    assert.equal(result.databaseOpen, false);
    assert.deepEqual(result.events, mode === 'start' ? ['start', 'stop'] : []);
  });
}

// Boundary: real factory/entry/SQLite, empty private instance, private tmux socket.
// Run for entry lifecycle changes; skip unrelated message-delivery changes.
test('normal dispatcher remains running and SIGTERM exits successfully', { timeout: 10000 }, async t => {
  const p = launch(t, environment(t)); p.readErrors();
  await until(() => p.stdout().includes('C4_RECOVER_MAX_AGE_SECONDS='));
  assert.match(p.stdout(), /C4 Session Router Started/);
  await delay(500); assert.equal(p.child.exitCode, null, p.stderr());
  assert.doesNotMatch(p.stderr(), /Dispatcher startup error/);
  p.child.kill('SIGTERM');
  assert.deepEqual(await p.closed, [0, null]);
});

// Boundary: real signal handler/DB close with an injected stop rejection.
// Run for entry lifecycle changes; skip unrelated delivery changes.
test('shutdown rejection retains its error log and exitCode without forced exit', { timeout: 10000 }, async t => {
  const env = { ...environment(t), DISPATCHER_FIXTURE_MODE: 'shutdown' };
  const p = launch(t, env, ['--no-warnings', '--experimental-test-module-mocks', '--import', fixture]); p.readErrors();
  await until(() => p.stdout().includes('C4 Session Router Started'));
  p.child.kill('SIGTERM');
  await until(() => p.stdout().includes('Dispatcher shutdown error: fixture shutdown failed'));
  assert.equal(p.child.exitCode, null);
  assert.doesNotMatch(p.stderr(), /Dispatcher startup error/);
  p.child.kill('SIGUSR2');
  assert.deepEqual(await p.closed, [1, null]);
  assert.equal(JSON.parse(fs.readFileSync(env.DISPATCHER_FIXTURE_RESULT)).databaseOpen, false);
});

// Boundary: real PM2 and unmocked production entry; a directory at c4.db forces
// startup failure. Requires local PM2; unrelated changes may skip this case.
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB are private and read back above.
test('PM2 observes real dispatcher startup failure and exhausts bounded restarts', { timeout: 30000 }, async t => {
  const env = environment(t);
  fs.mkdirSync(path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db'), { recursive: true });
  const pm2 = async args => {
    t.signal.throwIfAborted();
    return (await exec('pm2', args, { env, signal: t.signal, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  };
  const ecosystem = path.join(env.HOME, 'ecosystem.json');
  fs.writeFileSync(ecosystem, JSON.stringify({ apps: [{ name: 'dispatcher-startup', script: entry,
    cwd: env.HOME, min_uptime: 30000, max_restarts: 2, autorestart: true, env }] }));
  await pm2(['start', ecosystem]);
  let state;
  for (let i = 0; i < 40; i++) {
    const list = JSON.parse(await pm2(['jlist']));
    assert.equal(list.length, 1);
    state = list[0].pm2_env;
    if (state.status === 'errored') break;
    await delay(100);
  }
  assert.equal(state.status, 'errored');
  assert.ok(state.restart_time >= 1);
  assert.equal(state.exit_code, 1);
  const errors = fs.readFileSync(state.pm_err_log_path, 'utf8');
  assert.match(errors, /Dispatcher startup error:/);
  assert.match(errors, /at /);
  t.diagnostic(JSON.stringify({ status: state.status, restarts: state.restart_time, exitCode: state.exit_code }));
});
