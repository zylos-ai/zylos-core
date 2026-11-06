import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryBacklog } from '../src/lib/workbench/memory-backlog.js';
import { createGroupBacklog } from '../src/lib/workbench/group-backlog.js';
import { AuthGate } from '../src/lib/auth.js';
import { MemoryBrowser } from '../src/lib/memory-browser.js';
import { setupMemoryHttp } from './fixtures/memory-http.js';

const at = Date.UTC(2026, 0, 10, 12);
const utcText = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const unavailable = async () => { throw new Error('unavailable'); };
const defaults = {
  readConfig: async () => ({}), env: {}, now: () => at,
  getSnapshot: async () => ({ rows: [], hasOlder: false }),
  groupBacklog: async () => ({ count: 0, firstAt: null, syncing: false }),
};

test('memory backlog uses Core thresholds and UTC ages for active groups only', async () => {
  const calls = [], snapshotTimes = [];
  const values = new Map([
    ['origin', { count: 3, firstAt: utcText(at - 7 * 3600000), syncing: true }],
    ['telegram:dm-1', { count: 20, firstAt: utcText(at - 5 * 3600000), syncing: false }],
    ['openmax:research', { count: 2, firstAt: utcText(at - 6 * 3600000), syncing: null, reason: 'backlog_failed' }],
  ]);
  const get = createMemoryBacklog({ ...defaults,
    getSnapshot: async time => { snapshotTimes.push(time); return {
      rows: [...values.keys(), null, 'telegram:dm-1'].map(sessionGroup => ({ sessionGroup })), hasOlder: true,
    }; },
    groupBacklog: async group => { calls.push(group); return values.get(group); },
  });
  const result = await get(at);
  assert.deepEqual(snapshotTimes, [at]);
  assert.deepEqual(calls, [...values.keys()]);
  assert.equal(result.hasOlder, true);
  assert.deepEqual(result.groups.map(group => group.threshold), [50, 15, 15]);
  assert.deepEqual(result.groups.map(group => group.count), [3, 20, 2]);
  assert.equal(result.groups[1].count > result.groups[1].threshold, true);
  assert.deepEqual(result.groups.map(group => group.aged), [true, false, false]);
  assert.deepEqual(result.groups.map(group => group.syncing), [true, false, null]);
  assert.equal(result.groups[2].reason, 'backlog_failed');
  assert.deepEqual(result.budgets, { limits: { 'identity.md': 16384, 'references.md': 16384 }, warnings: { 'references.md': 8192 } });
});

test('memory backlog parses configured Origin threshold through Core', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.zylos'));
  await fs.writeFile(path.join(root, '.zylos/config.json'), JSON.stringify({ origin_sync_threshold: 73 }));
  const get = createMemoryBacklog({ ...defaults, zylosDir: root, readConfig: undefined,
    env: { ZYLOS_ORIGIN_SYNC_THRESHOLD: '61' },
    getSnapshot: async () => ({ rows: [{ sessionGroup: 'origin' }], hasOlder: false }),
  });
  assert.equal((await get()).groups[0].threshold, 61);
  const configured = createMemoryBacklog({ ...defaults, zylosDir: root, readConfig: undefined,
    getSnapshot: async () => ({ rows: [{ sessionGroup: 'origin' }], hasOlder: false }),
  });
  assert.equal((await configured()).groups[0].threshold, 73);
});

test('unavailable Core configuration and budgets omit their lines', async () => {
  const get = createMemoryBacklog({ ...defaults,
    loadConfiguration: unavailable, loadBudgets: unavailable,
    getSnapshot: async () => ({ rows: [{ sessionGroup: 'origin' }], hasOlder: null }),
  });
  const result = await get();
  assert.equal(result.groups[0].threshold, null);
  assert.equal(result.budgets, null);
  assert.equal(result.hasOlder, null);
});

test('one failed group preserves other backlog values and unknown sync status', async () => {
  const get = createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: ['telegram:a', 'telegram:b', 'telegram:c'].map(sessionGroup => ({ sessionGroup })), hasOlder: false }),
    groupBacklog: async group => {
      if (group === 'telegram:a') throw new Error('command failed');
      if (group === 'telegram:b') return { count: 20, firstAt: 'invalid', syncing: null, reason: 'backlog_failed' };
      return { count: null, firstAt: null, syncing: false, reason: 'backlog_failed' };
    },
  });
  const { groups } = await get();
  assert.deepEqual(groups[0], { sessionGroup: 'telegram:a', displayName: null, c4: { componentName: null },
    count: null, firstAt: null, aged: false, syncing: null, threshold: 15, reason: 'backlog_failed' });
  assert.equal(groups[1].count, 20);
  assert.equal(groups[1].syncing, null);
  assert.equal(groups[1].aged, false);
  assert.equal(groups[2].count, null);
  assert.equal(groups[2].syncing, false);
});

test('backlog reads use four workers and preserve snapshot order', async () => {
  let active = 0, maximum = 0, called = 0;
  const keys = Array.from({ length: 11 }, (_, i) => `telegram:g${i}`);
  const get = createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: keys.map(sessionGroup => ({ sessionGroup })), hasOlder: false }),
    groupBacklog: async () => {
      called++; active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { count: 1, syncing: false };
    },
  });
  const result = await get();
  assert.equal(maximum, 4);
  assert.equal(called, keys.length);
  assert.deepEqual(result.groups.map(group => group.sessionGroup), keys);
});

test('active group labels come from the snapshot without requiring memory directories', async () => {
  const get = createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: [
      { sessionGroup: 'channel:notes', name: { displayName: 'Research notes', source: 'human' },
        c4: { componentName: 'feishu', sessionGroupName: 'notes', lastActivityAt: at } },
      { sessionGroup: 'channel:unnamed', name: null, c4: { componentName: 'telegram' } },
    ], hasOlder: false }),
  });
  const { groups } = await get();
  assert.equal(groups[0].displayName, 'Research notes');
  assert.deepEqual(groups[0].c4, { componentName: 'feishu' });
  assert.equal(groups[1].displayName, null);
  assert.deepEqual(groups[1].c4, { componentName: 'telegram' });
});

test('single view null group is never queried and memory adds no cache', async () => {
  let reads = 0;
  const get = createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: [{ sessionGroup: null }, { sessionGroup: 'telegram:a' }], hasOlder: false }),
    groupBacklog: async group => { assert.equal(group, 'telegram:a'); return { count: ++reads, syncing: false }; },
  });
  assert.equal((await get()).groups[0].count, 1);
  assert.equal((await get()).groups[0].count, 2);
  const empty = createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: [{ sessionGroup: null }], hasOlder: false }),
    groupBacklog: async () => assert.fail('null group must not be queried'),
  });
  assert.equal((await empty()).groups.length, 0);
});

test('group details and memory reuse exactly one thirty second backlog cache', async () => {
  let time = at, c4Calls = 0, syncCalls = 0;
  const groupBacklog = createGroupBacklog({ zylosDir: '/isolated-zylos', now: () => time,
    runC4Db: async args => {
      assert.deepEqual(args, ['unsummarized', '--group', 'telegram:a', '--json']);
      c4Calls++;
      return { ok: true, data: { count: c4Calls, firstAt: utcText(at - 7 * 3600000) } };
    },
    execute: async () => { syncCalls++; return { stdout: JSON.stringify({ sync: { held: false } }) }; },
  });
  const get = createMemoryBacklog({ ...defaults, now: () => time, groupBacklog,
    getSnapshot: async () => ({ rows: [{ sessionGroup: 'telegram:a' }], hasOlder: false }),
  });
  await groupBacklog('telegram:a');
  assert.equal((await get()).groups[0].count, 1);
  time += 29999;
  await get();
  assert.equal(c4Calls, 1);
  assert.equal(syncCalls, 1);
  time++;
  assert.equal((await get()).groups[0].count, 2);
  assert.equal(c4Calls, 2);
  assert.equal(syncCalls, 2);
});

test('failed lock status keeps count and failed count keeps lock status', async () => {
  const make = failure => createGroupBacklog({ zylosDir: '/isolated-zylos',
    runC4Db: async () => failure === 'count' ? { ok: false } : { ok: true, data: { count: 20 } },
    execute: async () => {
      if (failure === 'sync') throw new Error('status failed');
      return { stdout: JSON.stringify({ sync: { held: true } }) };
    },
  });
  for (const failure of ['sync', 'count']) {
    const get = createMemoryBacklog({ ...defaults, groupBacklog: make(failure),
      getSnapshot: async () => ({ rows: [{ sessionGroup: 'telegram:a' }], hasOlder: false }),
    });
    const row = (await get()).groups[0];
    assert.equal(row.count, failure === 'count' ? null : 20);
    assert.equal(row.syncing, failure === 'sync' ? null : true);
    assert.equal(row.reason, 'backlog_failed');
  }
});

// Permission integration uses only in-memory sessions, no DB/network/children.
// Run for memory route or proxy authorization changes; skip UI-only changes.
test('memory routes require admin locally and through repeated proxy slashes', async t => {
  const token = `zylos_st_${'e'.repeat(64)}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let scope = 'read';
  const gate = new AuthGate({ auth: { enabled: true, password: 'scrypt:fixture' } }, {
    getApiSession: hash => hash === tokenHash ? { api_key_id: 71, scope, expires_at: Date.now() + 60000, key_revoked_at: null } : null,
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  for (const [method, route] of [['GET', '/api/workbench/memory/backlog'], ['PUT', '/api/memory/file']]) {
    for (const pathname of [route, `/fleet/Remote${route}`, `/fleet/Remote/${route}`]) {
      const url = new URL('http://hub.test'); url.pathname = pathname;
      const request = () => ({ method, url: pathname, headers: { authorization: `Bearer ${token}` } });
      const response = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
      scope = 'read';
      assert.equal(await gate.handle(request(), response, url), true, pathname);
      assert.equal(response.status, 403, pathname);
      assert.deepEqual(response.body, { error: 'insufficient_scope', required: 'admin' });
      scope = 'admin';
      assert.equal(await gate.handle(request(), response, url), false, pathname);
    }
  }
});



// HTTP integration covers route/auth dispatch, private SQLite display names and
// the shared backlog cache. Run for route/metadata changes; skip UI-only work.
// setupMemoryHttp owns isolated resources and registers bounded teardown.
test('memory backlog HTTP route shares the detail cache and enforces administrator access', { timeout: 15000 }, async t => {
  const { root, engine, request, calls, snapshotReads } = await setupMemoryHttp(t);
  const denied = await request('/api/workbench/memory/backlog');
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'insufficient_scope', required: 'admin' });
  assert.equal(calls.length, 0);
  const detail = await request('/api/workbench/groups/origin/backlog', 'admin');
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).count, 7);
  const before = calls.length;
  const snapshotBefore = snapshotReads();
  const response = await request('/api/workbench/memory/backlog', 'admin');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.groups.length, 1);
  assert.equal(value.groups[0].sessionGroup, 'origin');
  assert.equal(value.groups[0].count, 7);
  assert.equal(value.groups[0].syncing, false);
  assert.equal(value.groups[0].threshold, 50);
  assert.equal(value.budgets.limits['identity.md'], 16384);
  assert.equal(calls.length, before, 'memory and group detail must share one backlog reader cache');
  assert.equal(snapshotReads(), snapshotBefore + 1, 'memory asks the snapshot service to refresh active groups');
  assert.equal(engine.store.writeGroupDisplayName('telegram:dm-1001', 'Product notes', 'human'), true);
  const original = await new MemoryBrowser({ zylosDir: root }).tree();
  const treeResponse = await request('/api/memory/tree', 'admin');
  assert.equal(treeResponse.status, 200);
  const scoped = await treeResponse.json();
  assert.deepEqual(scoped.root, original.root, 'all original tree fields stay identical');
  assert.deepEqual(Object.keys(scoped).sort(), ['root', 'sessionGroups']);
  assert.deepEqual(scoped.sessionGroups, [
    { sessionGroup: 'origin', displayName: null },
    { sessionGroup: 'telegram:dm-1001', displayName: 'Product notes' },
  ]);
  assert.ok(scoped.root.children.find(node => node.path === 'session-groups').children.some(node => node.name === 'bad name'));
});
