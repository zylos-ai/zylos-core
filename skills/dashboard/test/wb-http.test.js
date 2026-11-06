import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import { createGroupSnapshot, workbenchResponse } from '../src/lib/workbench/group-snapshot.js';
import { PM2Collector } from '../src/lib/collectors/pm2-collector.js';
import { StateEngine } from '../src/lib/state-engine.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { AuthGate, hashApiKey } from '../src/lib/auth.js';

// Integration: actual createServer, authentication/method guards, API dispatch,
// snapshot/error mapping and collector callback. Run for these HTTP or sampling
// boundaries; skip rendering-only edits. Fresh HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR
// are required by the runner. Own temporary Dashboard SQLite and loopback server;
// Core/CLI and PM2 command inputs injected, no Core subprocess, tmux or live PM2.
// Every request is bounded; teardown closes server/DB/auth timer and owned root.
test('workbench HTTP routes retain read authentication, method guards and source error mapping', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-http-'));
  const dashboardDir = path.join(root, 'components/dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  let clock = 1800000000000, engine, collector, auth, service, server, failInbound = false, failSearch = false;
  const previous = process.env.ZYLOS_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    clearInterval(auth?._cleanupTimer);
    engine?.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  const childCalls = [];
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess,
    execFileSync: (file, args) => { childCalls.push([file, args]); return '1.0.0'; },
    execFile: () => { assert.fail('HTTP collection must not start a Core child'); },
  } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  t.mock.module('../src/lib/auth.js', { namedExports: {
    ...await import('../src/lib/auth.js'),
    AuthGate: class extends AuthGate { constructor(...args) { super(...args); auth = this; } },
  } });
  t.mock.module('../src/lib/collectors/pm2-collector.js', { namedExports: {
    PM2Collector: class extends PM2Collector { constructor(...args) { super(...args); collector = this; } },
  } });
  t.mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: {
    workbenchResponse,
    createGroupSnapshot: options => {
      service = createGroupSnapshot({ ...options, now: () => clock, c4Reader: { getInboundTimes: () => {
          if (failInbound) throw Object.assign(new Error('private inbound failure'), { statusCode: 502, code: 'READ_FAILED', reason: 'READ_FAILED' });
          return [];
        } },
        cli: {
          runC4Db: async args => {
            if (args.includes('--key-match')) return { ok: !failSearch, reason: 'c4_groups_failed', data: [], readAt: clock };
            return { ok: true, readAt: clock, data: args[0] === 'groups'
              ? { groups: [{ sessionGroup: 'telegram:a', componentName: 'telegram', lastActivityAt: clock }], hasOlder: false }
              : { groups: [], globalFence: null } };
          },
          readOverrides: async () => ({ ok: true, readAt: clock, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }),
        },
        loadCoreModule: async name => {
          if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi' }) };
          if (name === 'session-state-reader.js') return { readAccountUsage: async () => null };
          return { collectStatus: async () => {
            return { view: 'multi', origin: { presence: 'not_running' }, groups: [], groupListError: null,
              runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'ok' } } };
          } };
        },
      });
      return service;
    },
  } });
  process.env.ZYLOS_DIR = root;
  const { createServer } = await import(`../src/index.js?workbench-http=${Date.now()}`);
  if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // A real read-scoped session exercises the existing AuthGate, not a route stub.
  const token = `zylos_st_${'b'.repeat(64)}`, key = engine.store.insertApiKey({ name: 'fixture-read', keyHash: hashApiKey(`zylos_ak_${'c'.repeat(64)}`), scope: 'read' });
  engine.store.insertApiSession({ apiKeyId: Number(key.lastInsertRowid), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: Date.now(), scope: 'read', expiresAt: Date.now() + 60000 });
  const request = (route, options = {}) => fetch(origin + route, { signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${token}` }, ...options });
  for (const route of ['/api/workbench/groups', '/api/workbench/groups/search?q=', '/api/workbench/activity?range=60m']) {
    assert.equal((await request(route, { headers: {} })).status, 401, route);
    assert.equal((await request(route, { method: 'POST' })).status, 405, route);
  }
  for (const query of ['?range=1d', '']) {
    const response = await request('/api/workbench/activity' + query);
    assert.equal(response.status, 400); assert.equal((await response.json()).error, 'invalid_range');
  }
  const empty = await request('/api/workbench/groups/search?q=');
  assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), { rows: [], truncated: false });
  const activity = await request('/api/workbench/activity?range=60m');
  assert.equal(activity.status, 200); assert.equal((await activity.json()).groups['telegram:a'].cells.length, 60);
  // Exercise real collector.collect -> index _onUpdate -> counter and state engine.
  t.mock.method(collector, '_execPm2Jlist', async () => JSON.stringify([{ name: 'zylos-telegram', pm2_env: { status: 'errored' } }]));
  await collector.collect(); assert.equal(service.channelDownCounter.get('zylos-telegram'), 1);
  assert.equal(engine._state.pm2, collector.getLatestPM2Data());
  clock += 2100;
  assert.equal((await (await request('/api/workbench/groups')).json()).attention.problems.some(p => p.kind === 'channel_down'), false);
  await collector.collect(); clock += 2100;
  assert.equal((await (await request('/api/workbench/groups')).json()).attention.problems.some(p => p.kind === 'channel_down'), true);
  // Counter failure must not suppress the existing PM2 state callback.
  const realUpdate = service.channelDownCounter.update;
  service.channelDownCounter.update = () => { throw new Error('fixture counter failure'); };
  const data = { processes: [] };
  assert.throws(() => collector._onUpdate(data), /fixture counter failure/);
  assert.equal(engine._state.pm2, data);
  service.channelDownCounter.update = realUpdate;
  failSearch = true;
  const failedSearch = await request('/api/workbench/groups/search?q=telegram');
  assert.equal(failedSearch.status, 502); assert.deepEqual(await failedSearch.json(), { error: 'group_search_failed', reason: 'c4_groups_failed' });
  failInbound = true;
  const failedInbound = await request('/api/workbench/activity?range=6h');
  assert.equal(failedInbound.status, 502); assert.deepEqual(await failedInbound.json(), { error: 'READ_FAILED', reason: 'READ_FAILED' });
  failInbound = false;
  // Store unexpected failures map to internal_error, without exception text.
  const realQuery = engine.store.queryEvents;
  engine.store.queryEvents = () => { throw new Error('private storage details'); };
  clock += 2100;
  const unexpected = await request('/api/workbench/groups');
  assert.equal(unexpected.status, 500); assert.deepEqual(await unexpected.json(), { error: 'internal_error' });
  engine.store.queryEvents = realQuery;
  assert.equal(childCalls.every(([, args]) => args.length === 1 && args[0] === '--version'), true);
});
