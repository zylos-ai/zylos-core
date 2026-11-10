import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as childProcess from 'node:child_process';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { StateEngine } from '../../src/lib/state-engine.js';
import { AuthGate, hashApiKey } from '../../src/lib/auth.js';
import { C4Reader } from '../../src/lib/c4-reader.js';
import { EventLoopMonitor } from '../../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../../src/lib/version-checker.js';
import { createGroupBacklog } from '../../src/lib/workbench/group-backlog.js';
import { MemoryBrowser } from '../../src/lib/memory-browser.js';

// HTTP integration: actual createServer, AuthGate, route dispatch, display-name
// service and read-only C4Reader over private SQLite. Run for memory route/auth
// changes; skip rendering-only work. The official runner must isolate HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR and TMUX_TMPDIR before loading this file.
// All child_process/Core inputs are injected; no real CLI, PM2 or tmux/socket is
// used. The loopback server and each request are bounded; teardown closes every
// server/database/auth timer and removes only the owned temporary directory.
export async function setupMemoryHttp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-detail-http-'));
  const dashboardDir = path.join(root, 'components/dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'memory/session-groups/telegram:dm-1001'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory/session-groups/bad name'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory/session-groups/origin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory/identity.md'), 'identity fixture');
  fs.writeFileSync(path.join(root, 'memory/session-groups/telegram:dm-1001/handoff.md'), 'group fixture');
  fs.writeFileSync(path.join(dashboardDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  c4.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT, direction TEXT, channel TEXT, timestamp TEXT, content TEXT)');
  const put = c4.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)');
  put.run(1, null, 'in', 'telegram', '2026-10-01 12:00:00', 'private single body');
  put.run(2, 'origin', 'out', 'telegram', '2026-10-01 12:00:00', 'private Origin body');
  put.run(3, null, 'out', 'internal', '2026-10-01 12:00:00', 'private internal body');
  put.run(4, 'telegram:a', 'in', 'telegram', '2026-10-01 12:00:00', 'private ordinary body');
  let clock = 1800000000000;
  let engine, auth, reader, server, view = 'multi', snapshotReads = 0, cachedSnapshot = null;
  const calls = [], restarts = [];
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
      return { stdout: JSON.stringify({ ok: true, data: { id: 41 } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/comm-bridge/scripts/c4-db.js') && args[1] === 'groups') {
      const cutoff = Number(args[args.indexOf('--active-since') + 1]);
      return { stdout: JSON.stringify({ ok: true, data: { groups: groups.filter(row => row.lastActivityAt >= cutoff), hasOlder: false } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/comm-bridge/scripts/c4-db.js') && args[1] === 'unsummarized') {
      const global = !args.includes('--group');
      return { stdout: JSON.stringify({ ok: true, data: { count: global ? 3 : 7, firstAt: 100 } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/zylos-memory/scripts/sync-lock.js')) {
      return { stdout: JSON.stringify({ sync: { held: true }, origin: { held: false } }) };
    }
    assert.fail(`Unexpected child request: ${file} ${args.join(' ')}`);
  };
  const execFile = () => assert.fail('callback child invocation must not bypass the injected transport');
  execFile[promisify.custom] = async (...args) => execute(...args);
  t.mock.module('../../src/lib/workbench/group-backlog.js', { namedExports: {
    createGroupBacklog: options => createGroupBacklog({ ...options, execute: async (...args) => execute(...args) }),
  } });
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess, execFile,
    execFileSync: (file, args) => { assert.deepEqual(args, ['--version']); return '1.0.0'; },
    spawn: () => assert.fail('HTTP fixture must not spawn a process'),
  } });
  t.mock.module('../../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  t.mock.module('../../src/lib/auth.js', { namedExports: {
    ...await import('../../src/lib/auth.js'),
    AuthGate: class extends AuthGate { constructor(...args) { super(...args); auth = this; } },
  } });
  t.mock.module('../../src/lib/c4-reader.js', { namedExports: {
    C4Reader: class extends C4Reader { constructor(...args) { super(...args); reader = this; } },
  } });
  const snapshot = () => ({ view, rows: [{ sessionGroup: view === 'single' ? null : 'origin',
    live: { runId: view === 'single' ? 'single-run' : 'origin-run' } }], instance: {} });
  t.mock.module('../../src/lib/workbench/group-snapshot.js', { namedExports: {
    createGroupSnapshot: () => ({
      getSnapshot: async () => { snapshotReads++; cachedSnapshot = snapshot(); return cachedSnapshot; },
      getCachedSnapshot: () => cachedSnapshot,
      channelDownCounter: { update() {} },
    }),
    workbenchResponse: () => assert.fail('detail requests must not dispatch another workbench read route'),
  } });
  t.mock.module('../../src/lib/core-modules.js', { namedExports: {
    loadCoreModule: async name => {
      if (name === 'config.js') return { ZYLOS_DIR: root, readSessionMode: () => ({ mode: 'multi' }) };
      if (['model-rotation-thresholds.js', 'session-usage-reader.js', 'session-hot-ttl.js', 'config-store.js', 'config-lock.js', 'private-file.js', 'pm2.js'].includes(name)) {
        return import(new URL(`../../../../cli/lib/${name}`, import.meta.url));
      }
      if (name === 'am-sock-client.js') return {
        submit: async request => { restarts.push(request); return { kind: 'accepted', reply: { result: 'accepted' } }; },
        lookupRestartRequest: () => assert.fail('accepted restart must not query a second time'),
      };
      assert.fail(`Unexpected Core module: ${name}`);
    },
  } });
  process.env.ZYLOS_DIR = root;
  const { createServer } = await import(`../../src/index.js?memory-backlog-http=${clock}`);
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
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens[scope]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { root, engine, request, calls, snapshotReads: () => snapshotReads };
}
