import { test, expect, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { guardDatabase, planDatabaseMigration } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { readSessionModeStatus, readSupervisorPm2 } from '../cli/lib/session-mode-status.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-status-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'comm-bridge')); fs.mkdirSync(path.join(root, 'activity-monitor'));
  const filename = path.join(root, 'comm-bridge', 'c4.db'); const database = new Database(filename);
  guardDatabase(database, schema);
  const store = createStore(database, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) });
  return { root, filename, database, store };
}
const statusOptions = root => ({ zylosDir: root, readMode: () => ({ mode: 'single', keyPresent: true }), readPm2: () => 'stopped' });

test('IF31 E real P01 state survives deleted, rotated, and unreadable diagnostic stream with M4 stopped', async () => {
  const { root, filename, database, store } = fixture();
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  const reason = 'running_control_without_deadline:machine:17'; store.setModeTransitionPhase(runId, 'gating', { reason });
  const events = path.join(root, 'activity-monitor', 'supervisor-events.jsonl');
  fs.writeFileSync(events, JSON.stringify({ v: 1, event: 'transition_blocked', run_id: runId, reason, ts: 100 }) + '\n');
  database.close(); const beforeBytes = fs.readFileSync(filename);
  const withEvents = await readSessionModeStatus(statusOptions(root));
  expect(withEvents.supervisor).toBe('unreachable'); expect(withEvents.blocked.since).toBe(100);
  const authoritative = { ...withEvents, blocked: { reason, since: null }, lastEvents: [] };
  fs.renameSync(events, path.join(root, 'retained-stream'));
  expect(await readSessionModeStatus(statusOptions(root))).toEqual(authoritative);
  fs.mkdirSync(events); // An unreadable stream even for a privileged test runner.
  expect(await readSessionModeStatus(statusOptions(root))).toEqual(authoritative);
  fs.rmdirSync(events);
  fs.writeFileSync(events, JSON.stringify({ v: 1, event: 'transition_blocked', run_id: 'other-run', reason, ts: 200 }) + '\n');
  expect(await readSessionModeStatus(statusOptions(root))).toEqual(authoritative);
  expect(fs.readFileSync(filename)).toEqual(beforeBytes);
});

test('IF66 status observes completed D9 through P01 reader and new instance null without writes', async () => {
  const { root, filename, database, store } = fixture();
  let data = await readSessionModeStatus(statusOptions(root));
  expect(data.transition).toBeNull(); expect(data.lastCompleted).toBeNull(); expect(data.globalGate.present).toBe(false);
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  store.absorbForTransition(runId); store.setModeTransitionPhase(runId, 'cutover'); store.setModeTransitionPhase(runId, 'complete');
  database.close(); const before = fs.readFileSync(filename);
  data = await readSessionModeStatus(statusOptions(root));
  expect(data.transition).toBeNull(); expect(data.blocked).toBeNull(); expect(data.lastCompleted.runId).toBe(runId);
  expect(data.lastCompleted.sourceMode).toBe('single'); expect(data.lastCompleted.targetMode).toBe('multi');
  expect(fs.readFileSync(filename)).toEqual(before);
});

test('IB44 actual socket is connected exactly once without sending a request', async () => {
  const { root, database } = fixture(); database.close();
  let connections = 0, bytes = 0;
  const peers = new Set();
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('data', data => { bytes += data.length; }); socket.on('close', () => peers.delete(socket));
  });
  server.listen(path.join(root, 'activity-monitor', 'am.sock')); await once(server, 'listening');
  try {
    const data = await readSessionModeStatus({ ...statusOptions(root), readPm2: () => { throw new Error('must not query'); } });
    expect(data.supervisor).toBe('reachable'); expect(data.supervisorPm2).toBeUndefined();
    expect(connections).toBe(1); expect(bytes).toBe(0);
  } finally { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); }
});

test('IB44 missing database fails without bootstrapping directories or SQLite files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-status-missing-')); roots.push(root);
  await expect(readSessionModeStatus(statusOptions(root))).rejects.toThrow();
  expect(fs.readdirSync(root)).toEqual([]);
});

test('IB44 PM2 observation never starts a missing daemon and reads a real private daemon', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-status-pm2-')); roots.push(root);
  const home = path.join(root, 'pm2'); const env = { ...process.env, PM2_HOME: home, PM2_SILENT: 'true' };
  await expect(readSupervisorPm2({ env, timeoutMs: 30 })).rejects.toThrow();
  expect(fs.existsSync(home)).toBe(false);
  const execute = promisify(execFile);
  const entry = fileURLToPath(import.meta.resolve('pm2/bin/pm2'));
  const command = args => execute(process.execPath, [entry, ...args], { env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  const script = path.join(root, 'idle.mjs'); fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  try {
    await command(['start', script, '--name', 'activity-monitor', '--no-autorestart']);
    const pid = fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8');
    expect(await readSupervisorPm2({ env })).toBe('online');
    await command(['stop', 'activity-monitor']);
    expect(await readSupervisorPm2({ env })).toBe('stopped');
    expect(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8')).toBe(pid);
  } finally {
    if (fs.existsSync(path.join(home, 'pm2.pid'))) await command(['kill']);
    expect(fs.existsSync(path.join(home, 'pm2.pid'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'rpc.sock'))).toBe(false);
  }
}, 30000);

async function publicStatus(root, args = ['--json']) {
  const execute = promisify(execFile);
  try {
    const result = await execute(process.execPath, ['cli/zylos.js', 'session-mode', 'status', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'private-pm2'), PM2_RPC_PORT: '' },
      timeout: 10000,
    });
    return { ...result, code: 0 };
  } catch (error) { return error; }
}

test('public status CLI reports real blocked D9 with M4 absent, no PM2 startup or database writes', async () => {
  const { root, filename, database, store } = fixture();
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  store.setModeTransitionPhase(runId, 'gating', { reason: 'running_control_without_deadline:machine:17' });
  database.close();
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ session_mode: 'single' }));
  const before = fs.readFileSync(filename);
  const result = await publicStatus(root);
  expect(result.code).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const body = JSON.parse(result.stdout); expect(body.ok).toBe(true);
  expect(body.data.transition.runId).toBe(runId); expect(body.data.globalGate.present).toBe(true);
  expect(body.data.blocked).toEqual({ reason: 'running_control_without_deadline:machine:17', since: null });
  expect(body.data.supervisor).toBe('unreachable'); expect(body.data.supervisorPm2.status).toBe('unobservable');
  expect(fs.existsSync(path.join(root, 'private-pm2'))).toBe(false);
  expect(fs.readFileSync(filename)).toEqual(before);
  const text = await publicStatus(root, []);
  expect(text.code).toBe(0); expect(text.stdout).toContain(`Transition: ${runId} single -> multi (gating)`);
  expect(text.stdout).toContain('Global gate: present');
  expect(text.stdout).toContain('Supervisor: unreachable');
});

test('public status CLI succeeds with unreadable or missing F1 without repairing configuration', async () => {
  const { root, database } = fixture(); database.close();
  const noConfig = JSON.parse((await publicStatus(root)).stdout);
  expect(noConfig.ok).toBe(true); expect(noConfig.data.sessionMode).toBeNull();
  expect(fs.existsSync(path.join(root, '.zylos'))).toBe(false);
  fs.mkdirSync(path.join(root, '.zylos')); const config = path.join(root, '.zylos', 'config.json');
  fs.writeFileSync(config, '{broken');
  const broken = JSON.parse((await publicStatus(root)).stdout);
  expect(broken.ok).toBe(true); expect(broken.data.sessionMode).toBe('unreadable');
  expect(fs.readFileSync(config, 'utf8')).toBe('{broken');
});

test('public status CLI fails with one structured envelope when C4 is absent and creates no files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-status-cli-missing-')); roots.push(root);
  const result = await publicStatus(root);
  expect(result.code).toBe(1); expect(result.stderr).toBe('');
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const body = JSON.parse(result.stdout); expect(body.ok).toBe(false); expect(body.error.persisted).toEqual([]);
  expect(fs.readdirSync(root)).toEqual([]);
});

test('public status CLI connects once to real am.sock and transmits zero request bytes', async () => {
  const { root, database } = fixture(); database.close();
  let connections = 0, bytes = 0; const peers = new Set();
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('data', data => { bytes += data.length; }); socket.on('close', () => peers.delete(socket));
  });
  server.listen(path.join(root, 'activity-monitor', 'am.sock')); await once(server, 'listening');
  try {
    const result = await publicStatus(root);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).data.supervisor).toBe('reachable');
    expect(connections).toBe(1); expect(bytes).toBe(0);
  } finally { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); }
});

test('IB44 public status leaves a pending schema migration byte-identical instead of upgrading the database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-status-old-schema-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const filename = path.join(root, 'comm-bridge', 'c4.db');
  const database = new Database(filename);
  database.exec(fs.readFileSync(new URL('../skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.9.0-v1.sql', import.meta.url), 'utf8'));
  expect(database.pragma('user_version', { simple: true })).toBe(schema.SUPPORTED_SCHEMA_VERSION - 1);
  expect(planDatabaseMigration(database, schema, { strict: false }).steps.map(step => [step.from, step.to])).toEqual([[1, 2]]);
  database.close();
  const before = fs.readFileSync(filename); const filesBefore = fs.readdirSync(path.dirname(filename)).sort();
  const result = await publicStatus(root);
  // Assert the no-write invariant before the error contract, so an accidental
  // migration fails for its data change even if it also makes the query succeed.
  expect(fs.readFileSync(filename).equals(before)).toBe(true);
  expect(fs.readdirSync(path.dirname(filename)).sort()).toEqual(filesBefore);
  const readonly = new Database(filename, { readonly: true, fileMustExist: true });
  try { expect(readonly.pragma('user_version', { simple: true })).toBe(1); }
  finally { readonly.close(); }
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(fs.existsSync(path.join(root, 'private-pm2'))).toBe(false);
});
