import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as childProcess from 'node:child_process';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { StateEngine } from '../src/lib/state-engine.js';
import { AuthGate, hashApiKey } from '../src/lib/auth.js';
import { C4Reader, prepareLatestReceived, receivedMessage } from '../src/lib/c4-reader.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';

// HTTP integration: actual createServer, AuthGate, route dispatch, display-name
// service and read-only C4Reader over private SQLite. Run for detail routes,
// configuration writes or auth changes; skip rendering-only work. Isolate HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR and TMUX_TMPDIR before loading this file.
// All child_process/Core inputs are injected; no real CLI, PM2 or tmux/socket is
// used. The loopback server and each request are bounded; teardown closes every
// server/database/auth timer and removes only the owned temporary directory.
test('group detail HTTP dispatch enforces local scopes and preserves group boundaries', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-detail-http-'));
  const dashboardDir = path.join(root, 'components/dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  // The columns and tables Core's unsummarized calculation reads, beside the legacy rows (with no group) the single view lists.
  c4.exec(`CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT, direction TEXT, channel TEXT, timestamp TEXT, content TEXT, status TEXT DEFAULT 'delivered');
    CREATE TABLE checkpoints(id INTEGER PRIMARY KEY, session_group TEXT, end_conversation_id INTEGER, no_content INTEGER DEFAULT 0);
    CREATE TABLE mode_transitions(phase TEXT)`);
  const put = c4.prepare('INSERT INTO conversations(id,session_group,direction,channel,timestamp,content) VALUES(?,?,?,?,?,?)');
  put.run(1, null, 'in', 'telegram', '2026-10-01 12:00:00', 'private single body');
  put.run(2, 'origin', 'out', 'telegram', '2026-10-01 12:00:00', 'private Origin body');
  put.run(3, null, 'out', 'internal', '2026-10-01 12:00:00', 'private internal body');
  put.run(4, 'telegram:a', 'in', 'telegram', '2026-10-01 12:00:00', 'private ordinary body');
  // Origin's Sync marker: only a group with one asks sync-lock.js whether its Sync is held.
  fs.mkdirSync(path.join(root, 'activity-monitor/session-groups/origin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'activity-monitor/session-groups/origin/sync.lock'), '{}');
  let clock = 1800000000000;
  let engine, auth, reader, server, view = 'multi', cachedSnapshot = null;
  const calls = [], restarts = [];
  let controlFailure = null;
  const previous = process.env.ZYLOS_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    clearInterval(auth?._cleanupTimer);
    reader?.close();
    c4.close();
    engine?.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  // Version discovery is a startup dependency, outside the action transport
  // boundary whose exact child count and authorization this fixture proves.
  t.mock.module('../src/lib/installed-versions.js', { namedExports: {
    createInstalledVersionReader: () => async () => ({ zylos: '1.0.0', claude: '1.0.0', codex: '1.0.0' }),
  } });
  const groups = [
    { sessionGroup: 'telegram:recent', componentName: 'telegram', lastActivityAt: clock - 2 * 86400000 },
    { sessionGroup: 'telegram:old', componentName: 'telegram', lastActivityAt: clock - 5 * 86400000 },
    { sessionGroup: 'telegram:named', componentName: 'telegram', lastActivityAt: clock - 86400000 },
    { sessionGroup: 'origin', lastActivityAt: clock - 86400000 },
  ];
  const execute = (file, args) => {
    calls.push({ file, args });
    if (file === 'zylos' && args[0] === 'group') {
      return { stdout: JSON.stringify({ ok: true, data: { resolved: { runtime: 'claude' }, marker: 'configuration-handler' } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/comm-bridge/scripts/c4-control.js')) {
      if (controlFailure) throw controlFailure;
      return { stdout: JSON.stringify({ ok: true, data: { id: 41 } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/comm-bridge/scripts/c4-db.js') && args[1] === 'groups') {
      const cutoff = Number(args[args.indexOf('--active-since') + 1]);
      return { stdout: JSON.stringify({ ok: true, data: { groups: groups.filter(row => row.lastActivityAt >= cutoff), hasOlder: false } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/zylos-memory/scripts/sync-lock.js')) {
      return { stdout: JSON.stringify({ sync: { held: true }, origin: { held: false } }) };
    }
    assert.fail(`Unexpected child request: ${file} ${args.join(' ')}`);
  };
  const execFile = () => assert.fail('callback child invocation must not bypass the injected transport');
  execFile[promisify.custom] = async (...args) => execute(...args);
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess, execFile,
    execFileSync: (file, args) => { assert.deepEqual(args, ['--version']); return '1.0.0'; },
    spawn: () => assert.fail('HTTP fixture must not spawn a process'),
  } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  t.mock.module('../src/lib/auth.js', { namedExports: {
    ...await import('../src/lib/auth.js'),
    AuthGate: class extends AuthGate { constructor(...args) { super(...args); auth = this; } },
  } });
  t.mock.module('../src/lib/c4-reader.js', { namedExports: {
    prepareLatestReceived, receivedMessage,
    C4Reader: class extends C4Reader { constructor(...args) { super(...args); reader = this; } },
  } });
  const snapshot = () => ({ view, rows: [{ sessionGroup: view === 'single' ? null : 'origin',
    live: { runId: view === 'single' ? 'single-run' : 'origin-run' } }], instance: {} });
  t.mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: {
    createGroupSnapshot: () => ({
      getSnapshot: async () => { cachedSnapshot = snapshot(); return cachedSnapshot; },
      getCachedSnapshot: () => cachedSnapshot,
      channelRestartCounter: { update() {} },
    }),
  } });
  t.mock.module('../src/lib/core-modules.js', { namedExports: {
    loadCoreModule: async name => {
      if (['runtime/descriptors.js', 'runtime/index.js', 'runtime/contract.js'].includes(name)) return import(new URL(`../../../cli/lib/${name}`, import.meta.url));
      if (['model-rotation-thresholds.js', 'session-usage-reader.js', 'session-hot-ttl.js', 'config-store.js', 'config-lock.js', 'private-file.js', 'pm2.js', 'session-nudge.js', 'session-group-paths.js'].includes(name)) return import(new URL('../../../cli/lib/' + name, import.meta.url));
      if (name === 'config.js') return { ZYLOS_DIR: root, readSessionMode: () => ({ mode: 'multi' }) };
      if (name === 'am-sock-client.js') return {
        submit: async request => { restarts.push(request); return { kind: 'accepted', reply: { result: 'accepted' } }; },
        lookupRestartRequest: () => assert.fail('accepted restart must not query a second time'),
      };
      assert.fail(`Unexpected Core module: ${name}`);
    },
  } });
  process.env.ZYLOS_DIR = root;
  console.log('Detail HTTP isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: path.join(dashboardDir, 'dashboard.db'), transport: 'loopback; all children injected' }));
  const { createServer } = await import(`../src/index.js?group-detail-http=${clock}`);
  if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  for (const [index, scope] of ['read', 'admin'].entries()) {
    const token = `zylos_st_${String(index + 1).repeat(64)}`;
    const key = engine.store.insertApiKey({ name: `fixture-${scope}`, keyHash: hashApiKey(`zylos_ak_${String(index + 3).repeat(64)}`), scope });
    engine.store.insertApiSession({ apiKeyId: Number(key.lastInsertRowid), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: clock, scope, expiresAt: clock + 60000 });
    tokens[scope] = token;
  }
  const request = (route, scope = 'read', body) => fetch(origin + route, {
    signal: AbortSignal.timeout(3000),
    method: body === undefined ? 'GET' : route.endsWith('/config') ? 'PUT' : 'POST',
    headers: { Authorization: `Bearer ${tokens[scope]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const writes = [
    { route: '/config', body: { kind: 'runtime', value: 'codex' } },
    ...['interrupt', 'chop-chop', 'restart'].map(action => ({ route: `/actions/${action}`, body: { runId: 'fixture-run', sessionId: 'fixture-session' } })),
  ];

  await t.test('local read keys cannot submit configuration or any group action', async () => {
    const before = calls.length;
    for (const { route, body } of writes) {
      const response = await request('/api/groups/telegram%3Aa' + route, 'read', body);
      assert.equal(response.status, 403, route);
      assert.deepEqual(await response.json(), { ok: false, error: { code: 'insufficient_scope', message: 'insufficient_scope' }, required: 'admin' });
    }
    assert.equal(calls.length, before, 'denied writes must never reach a child transport');
    assert.equal(restarts.length, 0);
  });








  await t.test('invalid group keys are rejected before any child command or restart submission', async () => {
    const before = calls.length, restartBefore = restarts.length;
    for (const key of ['--json', 'a%2Fb']) {
      const base = '/api/groups/' + key;
      for (const suffix of ['/runs', '/events', '/messages', '/backlog', '']) {
        const response = await request(base + suffix, 'admin');
        assert.equal(response.status, 400, key + suffix);
        assert.equal((await response.json()).error.code, 'SESSION_GROUP_INVALID');
      }
      for (const { route, body } of writes) {
        const response = await request(base + route, 'admin', body);
        assert.equal(response.status, 400, key + route);
        assert.equal((await response.json()).error.code, 'SESSION_GROUP_INVALID');
      }
    }
    assert.equal(calls.length, before);
    assert.equal(restarts.length, restartBefore);
  });
});
