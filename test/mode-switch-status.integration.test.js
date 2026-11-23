import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { guardDatabase, planDatabaseMigration } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';

// Run for session-mode status, read-only C4, supervisor socket or PM2 probe
// changes. Skip for unrelated changes. Cases use private databases, fixture
// sockets and scoped PM2 shims under the isolated runner.
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-status-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'comm-bridge')); fs.mkdirSync(path.join(root, 'activity-monitor'));
  const filename = path.join(root, 'comm-bridge', 'c4.db'); const database = new Database(filename);
  guardDatabase(database, schema);
  const store = createStore(database, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) });
  return { root, filename, database, store };
}
const statusOptions = root => ({ zylosDir: root, readMode: () => ({ mode: 'single', keyPresent: true }), readPm2: () => 'stopped' });

test('Real state survives deleted, rotated, and unreadable diagnostic stream with supervisor stopped', { timeout: 5000 }, async () => {
  const { root, filename, database, store } = fixture();
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  const reason = 'running_control_without_deadline:machine:17'; store.setModeTransitionPhase(runId, 'gating', { reason });
  const events = path.join(root, 'activity-monitor', 'supervisor-events.jsonl');
  fs.writeFileSync(events, JSON.stringify({ v: 1, event: 'transition_blocked', run_id: runId, reason, ts: 100 }) + '\n');
  database.close(); const beforeBytes = fs.readFileSync(filename);
  const withEvents = await readSessionModeStatus(statusOptions(root));
  assert.equal(withEvents.supervisor, 'unreachable'); assert.equal(withEvents.blocked.since, 100);
  const authoritative = { ...withEvents, blocked: { reason, since: null }, lastEvents: [] };
  fs.renameSync(events, path.join(root, 'retained-stream'));
  assert.deepEqual(await readSessionModeStatus(statusOptions(root)), authoritative);
  fs.mkdirSync(events); // An unreadable stream even for a privileged test runner.
  assert.deepEqual(await readSessionModeStatus(statusOptions(root)), authoritative);
  fs.rmdirSync(events);
  fs.writeFileSync(events, JSON.stringify({ v: 1, event: 'transition_blocked', run_id: 'other-run', reason, ts: 200 }) + '\n');
  assert.deepEqual(await readSessionModeStatus(statusOptions(root)), authoritative);
  assert.deepEqual(fs.readFileSync(filename), beforeBytes);
});

test('status observes completed through reader and new instance null without writes', { timeout: 5000 }, async () => {
  const { root, filename, database, store } = fixture();
  let data = await readSessionModeStatus(statusOptions(root));
  assert.equal(data.transition, null); assert.equal(data.lastCompleted, null); assert.equal(data.globalGate.present, false);
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  store.setModeTransitionPhase(runId, 'cutover'); store.setModeTransitionPhase(runId, 'complete');
  database.close(); const before = fs.readFileSync(filename);
  data = await readSessionModeStatus(statusOptions(root));
  assert.equal(data.transition, null); assert.equal(data.blocked, null); assert.equal(data.lastCompleted.runId, runId);
  assert.equal(data.lastCompleted.sourceMode, 'single'); assert.equal(data.lastCompleted.targetMode, 'multi');
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('actual socket is connected exactly once without sending a request', { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  let connections = 0, bytes = 0;
  const peers = new Set();
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('data', data => { bytes += data.length; }); socket.on('close', () => peers.delete(socket));
  });
  server.listen(path.join(root, 'activity-monitor', 'am.sock')); await once(server, 'listening');
  try {
    const data = await readSessionModeStatus({ ...statusOptions(root), readPm2: () => { throw new Error('must not query'); } });
    assert.equal(data.supervisor, 'reachable'); assert.equal(data.supervisorPm2, undefined);
    assert.equal(connections, 1); assert.equal(bytes, 0);
  } finally { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); }
});

test('missing database fails without bootstrapping directories or SQLite files', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-status-missing-')); roots.push(root);
  await assert.rejects(readSessionModeStatus(statusOptions(root)), Error);
  assert.deepEqual(fs.readdirSync(root), []);
});

async function publicStatus(root, args = ['--json'], extraEnv = {}) {
  const execute = promisify(execFile);
  // Keep accidental PM2 calls inside a recording, non-daemonizing fixture.
  const pm2Root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-status-pm2-')); roots.push(pm2Root);
  const safePm2 = pm2Cli(pm2Root, 'process.exit(1);');
  try {
    const result = await execute(process.execPath, ['cli/zylos.js', 'session-mode', 'status', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'private-pm2'), PM2_RPC_PORT: '', ...safePm2, ...extraEnv },
      timeout: 10000,
    });
    return { ...result, code: 0 };
  } catch (error) { return error; }
}

test('public status CLI reports real blocked with supervisor absent, no PM2 startup or database writes', { timeout: 5000 }, async () => {
  const { root, filename, database, store } = fixture();
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  store.setModeTransitionPhase(runId, 'gating', { reason: 'running_control_without_deadline:machine:17' });
  database.close();
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ session_mode: 'single' }));
  const before = fs.readFileSync(filename);
  const result = await publicStatus(root);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const body = JSON.parse(result.stdout); assert.equal(body.ok, true);
  assert.equal(body.data.transition.runId, runId); assert.equal(body.data.globalGate.present, true);
  assert.deepEqual(body.data.blocked, { reason: 'running_control_without_deadline:machine:17', since: null });
  assert.equal(body.data.supervisor, 'unreachable'); assert.deepEqual(body.data.supervisorPm2, { status: 'daemon_not_running', error: null });
  assert.equal(fs.existsSync(path.join(root, 'private-pm2')), false);
  assert.deepEqual(fs.readFileSync(filename), before);
  const text = await publicStatus(root, []);
  assert.equal(text.code, 0); assert.ok(text.stdout.includes(`Transition: ${runId} single -> multi (gating)`));
  assert.ok(text.stdout.includes('Global gate: present'));
  assert.ok(text.stdout.includes('Supervisor: unreachable'));
});

test('public status CLI succeeds with unreadable or missing F1 without repairing configuration', { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  const noConfig = JSON.parse((await publicStatus(root)).stdout);
  assert.equal(noConfig.ok, true); assert.equal(noConfig.data.sessionMode, null);
  assert.equal(fs.existsSync(path.join(root, '.zylos')), false);
  fs.mkdirSync(path.join(root, '.zylos')); const config = path.join(root, '.zylos', 'config.json');
  fs.writeFileSync(config, '{broken');
  const broken = JSON.parse((await publicStatus(root)).stdout);
  assert.equal(broken.ok, true); assert.equal(broken.data.sessionMode, 'unreadable');
  assert.equal(fs.readFileSync(config, 'utf8'), '{broken');
});

test('public status CLI fails with one structured envelope when C4 is absent and creates no files', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-status-cli-missing-')); roots.push(root);
  const result = await publicStatus(root);
  assert.equal(result.code, 1); assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const body = JSON.parse(result.stdout); assert.equal(body.ok, false); assert.deepEqual(body.error.persisted, []);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('public status CLI connects once to real am.sock and transmits zero request bytes', { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  let connections = 0, bytes = 0; const peers = new Set();
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('data', data => { bytes += data.length; }); socket.on('close', () => peers.delete(socket));
  });
  server.listen(path.join(root, 'activity-monitor', 'am.sock')); await once(server, 'listening');
  try {
    const result = await publicStatus(root);
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).data.supervisor, 'reachable');
    assert.equal(connections, 1); assert.equal(bytes, 0);
  } finally { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); }
});

// Public CLI integration covers read-only access to a historical schema. Run for
// status/schema changes; unrelated UI work may skip. The runner supplies isolated
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; publicStatus uses this private DB and a
// recording PM2 fixture. No tmux is launched; owned directories are removed.
test('public status leaves a pending schema migration byte-identical instead of upgrading the database', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-status-old-schema-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const filename = path.join(root, 'comm-bridge', 'c4.db');
  const database = new Database(filename);
  database.exec(fs.readFileSync(new URL('../skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.9.0-v1.sql', import.meta.url), 'utf8'));
  const fixtureVersion = 1;
  assert.equal(database.pragma('user_version', { simple: true }), fixtureVersion);
  const expectedSteps = Array.from({ length: schema.SUPPORTED_SCHEMA_VERSION - fixtureVersion },
    (_, index) => [fixtureVersion + index, fixtureVersion + index + 1]);
  assert.deepEqual(planDatabaseMigration(database, schema, { strict: false }).steps.map(step => [step.from, step.to]), expectedSteps);
  database.close();
  const before = fs.readFileSync(filename); const filesBefore = fs.readdirSync(path.dirname(filename)).sort();
  console.log('Status migration isolation:', JSON.stringify({ HOME: root, ZYLOS_DIR: root,
    PM2_HOME: path.join(root, 'private-pm2'), TMPDIR: process.env.TMPDIR,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR, database: filename,
    amSocket: path.join(root, 'activity-monitor/am.sock'), tmux: 'not launched' }));
  const result = await publicStatus(root);
  // Assert the no-write invariant before the error contract, so an accidental
  // migration fails for its data change even if it also makes the query succeed.
  assert.equal(fs.readFileSync(filename).equals(before), true);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)).sort(), filesBefore);
  const readonly = new Database(filename, { readonly: true, fileMustExist: true });
  try { assert.equal(readonly.pragma('user_version', { simple: true }), 1); }
  finally { readonly.close(); }
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(fs.existsSync(path.join(root, 'private-pm2')), false);
});

function pm2Cli(root, body) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const executable = path.join(bin, 'pm2');
  fs.writeFileSync(executable, String.raw`#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
fs.appendFileSync(path.join(process.env.HOME, 'pm2-calls'), JSON.stringify(process.argv.slice(2)) + '\n');
${body}
`, { mode: 0o700 });
  // The executable has no extension, so declare ESM for this isolated CLI fixture.
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

async function pm2Socket(root) {
  const home = path.join(root, 'private-pm2'); fs.mkdirSync(home);
  const server = net.createServer(socket => socket.destroy());
  server.listen(path.join(home, 'rpc.sock')); await once(server, 'listening');
  return server;
}

test('public status default PM2 shim records invocation and cannot start a daemon', { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  const server = await pm2Socket(root);
  try {
    const result = await publicStatus(root);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).data.supervisorPm2, {
      status: 'unobservable', error: { code: 'READ_FAILED', message: 'Unable to collect PM2 process status' },
    });
    assert.equal(fs.readFileSync(path.join(root, 'pm2-calls'), 'utf8').trim(), '["jlist"]');
    assert.equal(fs.existsSync(path.join(root, 'private-pm2', 'pm2.pid')), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('missing PM2 socket skips the CLI and leaves no daemon after public status exits', { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  const env = pm2Cli(root, `fs.mkdirSync(process.env.PM2_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), String(process.pid));
console.log('[]');`);
  const result = await publicStatus(root, ['--json'], env);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).data.supervisorPm2, { status: 'daemon_not_running', error: null });
  assert.equal(fs.existsSync(path.join(root, 'pm2-calls')), false);
  assert.equal(fs.existsSync(path.join(root, 'private-pm2')), false);
});

test('residual PM2 socket skips jlist and does not start a daemon', { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  const home = path.join(root, 'private-pm2'); fs.mkdirSync(home);
  const socketPath = path.join(home, 'rpc.sock');
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import net from 'node:net'; net.createServer().listen(process.argv[1], () => process.send('ready'));", socketPath], {
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: home },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    assert.equal((await once(child, 'message'))[0], 'ready');
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    assert.equal(fs.statSync(socketPath).isSocket(), true);
    const env = pm2Cli(root, `fs.writeFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), String(process.pid));
console.log('[]');`);
    const result = await publicStatus(root, ['--json'], env);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).data.supervisorPm2, { status: 'daemon_not_running', error: null });
    assert.equal(fs.existsSync(path.join(root, 'pm2-calls')), false);
    assert.equal(fs.existsSync(path.join(home, 'pm2.pid')), false);
    assert.equal(fs.statSync(socketPath).isSocket(), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

for (const [label, output, status] of [
  ['no activity-monitor', '[]', 'not_found'],
  ['activity-monitor online', '[{"name":"activity-monitor","pm2_env":{"status":"online"}}]', 'online'],
  ['activity-monitor stopped', '[{"name":"activity-monitor","pm2_env":{"status":"stopped"}}]', 'stopped'],
]) test(`existing PM2 socket uses public jlist: ${label}`, { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  const env = pm2Cli(root, `console.log('PM2 version notice');
console.log(${JSON.stringify(output)});`);
  const server = await pm2Socket(root);
  try {
    const result = await publicStatus(root, ['--json'], env);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).data.supervisorPm2, { status, error: null });
    assert.equal(fs.readFileSync(path.join(root, 'pm2-calls'), 'utf8').trim(), '["jlist"]');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const [label, body, message] of [
  ['command failure', "console.error('private output must not leak'); process.exit(2);", 'Unable to collect PM2 process status'],
  // Finish successfully after the product deadline: removing that deadline must
  // fail the assertion without leaving a long-lived fixture process.
  ['timeout', "setTimeout(() => { console.log('[]'); }, 2000);", 'Unable to collect PM2 process status'],
  ['invalid output', "console.log('not JSON');", 'PM2 returned invalid JSON'],
]) test(`public status preserves authoritative state when PM2 jlist has ${label}`, { timeout: 5000 }, async () => {
  const { root, database, store } = fixture();
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*'); database.close();
  const env = pm2Cli(root, body); const server = await pm2Socket(root);
  try {
    const result = await publicStatus(root, ['--json'], env);
    assert.equal(result.code, 0);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.supervisor, 'unreachable'); assert.equal(data.transition.runId, runId); assert.equal(data.globalGate.present, true);
    assert.deepEqual(data.supervisorPm2, { status: 'unobservable', error: { code: 'READ_FAILED', message } });
    assert.ok(!result.stdout.includes('private output must not leak'));
    assert.equal(fs.readFileSync(path.join(root, 'pm2-calls'), 'utf8').trim(), '["jlist"]');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
