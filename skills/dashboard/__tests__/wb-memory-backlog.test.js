import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createMemoryBacklog, memoryBacklogPage, parseBacklogQuery, readBacklogPage } from '../src/lib/workbench/memory-backlog.js';
import { createGroupBacklog } from '../src/lib/workbench/group-backlog.js';
import { createOriginBacklog } from '../src/lib/workbench/origin-backlog.js';
import { AuthGate } from '../src/lib/auth.js';
import { MemoryBrowser } from '../src/lib/memory-browser.js';
import { setupMemoryHttp } from './fixtures/memory-http.js';
import { BUDGETS, WARN_THRESHOLDS } from '../../zylos-memory/scripts/memory-budget.js';

const at = Date.UTC(2026, 0, 10, 12);
const utcText = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const unavailable = async () => { throw new Error('unavailable'); };
// The group reader's interface over a per-group answer; the real reader reads every group at once.
const reader = answer => ({ many: async keys => Promise.all(keys.map(async key => answer(key))) });
const defaults = {
  readConfig: async () => ({}), env: {}, now: () => at,
  getSnapshot: async () => ({ rows: [], hasOlder: false }),
  groupBacklog: reader(() => ({ count: 1, firstAt: null, syncing: false })),
};
// Sync marker files for the group reader: a group listed here has one, so its status is asked.
const markerRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mback-markers-'));
after(() => fsSync.rmSync(markerRoot, { recursive: true, force: true }));
function markerPaths(...groups) {
  for (const group of groups) {
    fsSync.mkdirSync(path.join(markerRoot, group), { recursive: true });
    fsSync.writeFileSync(path.join(markerRoot, group, 'sync.lock'), '{}');
  }
  return async () => ({ groupRunDir: group => path.join(markerRoot, group) });
}
// Core's ranges for each scope, from an in-memory answer (no database).
const ranges = (answer, counted = { calls: 0 }) => ({ getUnsummarizedRanges: scopes => { counted.calls++; return scopes.map(answer); } });

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
    groupBacklog: reader(group => { calls.push(group); return values.get(group); }),
  });
  const result = await get(at);
  assert.deepEqual(snapshotTimes, [at]);
  assert.deepEqual(calls, [...values.keys()]);
  assert.deepEqual(result.groups.map(group => group.threshold), [15, 15, 15], 'Origin\'s own conversation uses the group threshold');
  assert.deepEqual(result.groups.map(group => group.count), [3, 20, 2]);
  assert.equal(result.groups[1].count > result.groups[1].threshold, true);
  assert.deepEqual(result.groups.map(group => group.aged), [true, false, false]);
  assert.deepEqual(result.groups.map(group => group.syncing), [true, false, null]);
  assert.equal(result.groups[2].reason, 'backlog_failed');
  assert.deepEqual(result.budgets, { limits: BUDGETS, warnings: WARN_THRESHOLDS, checks: { 'identity.md': null, 'references.md': null } });
});

test('the configured Origin Sync threshold goes to the cross-group row, never to Origin\'s own row', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.zylos'));
  await fs.writeFile(path.join(root, '.zylos/config.json'), JSON.stringify({ origin_sync_threshold: 73 }));
  const options = { ...defaults, zylosDir: root, readConfig: undefined,
    getSnapshot: async () => ({ view: 'multi', rows: [{ sessionGroup: 'origin' }], hasOlder: false }),
    originBacklog: async () => ({ count: 0, pendingSummaries: 0, firstAt: null, syncing: false }) };
  const fromEnv = await createMemoryBacklog({ ...options, env: { ZYLOS_ORIGIN_SYNC_THRESHOLD: '61' } })();
  assert.equal(fromEnv.originSync.threshold, 61);
  assert.equal(fromEnv.groups[0].threshold, 15);
  const configured = await createMemoryBacklog(options)();
  assert.equal(configured.originSync.threshold, 73);
  assert.equal(configured.groups[0].threshold, 15);
});

// The Origin rows below read through the real group and cross-group readers; Core's ranges, the
// cross-group C4 child and sync-lock children are in-memory answers (no process or database).
const lockStatus = (sync, origin) => async () => ({ stdout: JSON.stringify({ sync: { held: sync }, origin: { held: origin } }) });
function originReaders({ execute, crossFails = false } = {}) {
  const runC4Db = async args => {
    assert.deepEqual(args, ['origin-sync', 'backlog', '--json']);
    if (crossFails) return { ok: false, reason: 'origin_backlog_failed' };
    return { ok: true, data: { total: 60, groups: [
      { sessionGroup: 'telegram:a', count: 45, firstAt: utcText(at - 2 * 3600000), pendingCheckpoints: 2, firstCheckpointAt: utcText(at - 8 * 3600000) },
      { sessionGroup: 'telegram:b', count: 15, firstAt: utcText(at - 4 * 3600000), pendingCheckpoints: 0, firstCheckpointAt: null },
    ] } };
  };
  return {
    groupBacklog: createGroupBacklog({ zylosDir: '/isolated-zylos', execute, now: () => at, loadPaths: markerPaths('origin', 'telegram:a'),
      c4Reader: ranges(() => ({ count: 3, firstAt: utcText(at - 3600000) })) }),
    originBacklog: createOriginBacklog({ zylosDir: '/isolated-zylos', runC4Db, execute, now: () => at }),
  };
}
const multiOrigin = { ...defaults, getSnapshot: async () => ({ view: 'multi', rows: [{ sessionGroup: 'origin' }, { sessionGroup: 'telegram:a' }], hasOlder: false }) };

test('Origin\'s own row compares its own backlog with the group threshold; the cross-group row carries the machine-wide backlog', async () => {
  const result = await createMemoryBacklog({ ...multiOrigin, ...originReaders({ execute: lockStatus(false, false) }) })(at);
  const own = result.groups[0];
  assert.equal(own.sessionGroup, 'origin');
  assert.equal(own.count, 3);
  assert.equal(own.threshold, 15);
  assert.equal(own.count > own.threshold, false);
  assert.deepEqual(result.originSync, { count: 60, pendingSummaries: 2, firstAt: utcText(at - 8 * 3600000),
    aged: true, syncing: false, threshold: 50 }, 'the oldest time includes unread summaries, as the Supervisor computes it');
  assert.equal(result.originSync.count > result.originSync.threshold, true);
});

test('the group sync lock marks only Origin\'s own row and the Origin Sync lock marks only the cross-group row', async () => {
  const own = await createMemoryBacklog({ ...multiOrigin, ...originReaders({ execute: lockStatus(true, false) }) })(at);
  assert.equal(own.groups[0].syncing, true);
  assert.equal(own.originSync.syncing, false);
  const cross = await createMemoryBacklog({ ...multiOrigin, ...originReaders({ execute: lockStatus(false, true) }) })(at);
  assert.equal(cross.groups[0].syncing, false);
  assert.equal(cross.originSync.syncing, true);
});

test('a failed cross-group read shows that row as unknown and leaves the group rows intact', async () => {
  const result = await createMemoryBacklog({ ...multiOrigin, ...originReaders({ execute: lockStatus(false, true), crossFails: true }) })(at);
  assert.deepEqual(result.originSync, { count: null, pendingSummaries: null, firstAt: null, aged: false,
    syncing: true, threshold: 50, reason: 'origin_backlog_failed' });
  assert.deepEqual(result.groups.map(group => [group.count, group.syncing, group.reason]), [[3, false, undefined], [3, false, undefined]]);
  const thrown = await createMemoryBacklog({ ...multiOrigin, groupBacklog: reader(() => ({ count: 4, syncing: false })),
    originBacklog: async () => { throw new Error('reader failed'); } })(at);
  assert.equal(thrown.originSync.count, null);
  assert.equal(thrown.originSync.syncing, null);
  assert.deepEqual(thrown.groups.map(group => group.count), [4, 4]);
  const malformed = createOriginBacklog({ zylosDir: '/isolated-zylos', execute: lockStatus(false, false),
    runC4Db: async () => ({ ok: true, data: { total: 5, groups: [{ pendingCheckpoints: -1 }] } }) });
  assert.equal((await malformed()).count, null, 'a malformed backlog is unknown, not a number');
});

test('the cross-group row exists only in multi mode', async () => {
  for (const view of ['single', null, undefined]) {
    const result = await createMemoryBacklog({ ...defaults,
      getSnapshot: async () => ({ view, rows: [{ sessionGroup: 'telegram:a' }], hasOlder: false }),
      originBacklog: async () => assert.fail('the cross-group backlog is read only in multi mode') })(at);
    assert.equal('originSync' in result, false, String(view));
  }
});

test('the cross-group reader keeps its answer for thirty seconds', async () => {
  let time = at, reads = 0;
  const get = createOriginBacklog({ zylosDir: '/isolated-zylos', now: () => time, execute: lockStatus(false, false),
    runC4Db: async () => ({ ok: true, data: { total: ++reads, groups: [] } }) });
  assert.equal((await get()).count, 1);
  time += 29999;
  assert.equal((await get()).count, 1);
  time++;
  assert.equal((await get()).count, 2);
});

test('unavailable Core configuration and budgets omit their lines', async () => {
  const get = createMemoryBacklog({ ...defaults,
    loadConfiguration: unavailable, loadBudgets: unavailable,
    getSnapshot: async () => ({ rows: [{ sessionGroup: 'origin' }], hasOlder: null }),
  });
  const result = await get();
  assert.equal(result.groups[0].threshold, null);
  assert.equal(result.budgets, null);
});

test('a failed read lists the group with its reason, and a failed reader lists every group as unreadable', async () => {
  const rows = ['telegram:a', 'telegram:b', 'telegram:c'].map(sessionGroup => ({ sessionGroup }));
  const get = createMemoryBacklog({ ...defaults, getSnapshot: async () => ({ rows, hasOlder: false }),
    groupBacklog: reader(group => group === 'telegram:a' ? { count: 0, firstAt: null, syncing: false }
      : group === 'telegram:b' ? { count: 20, firstAt: 'invalid', syncing: null, reason: 'backlog_failed' }
        : { count: null, firstAt: null, syncing: false, reason: 'backlog_failed' }),
  });
  const { groups } = await get();
  assert.deepEqual(groups.map(row => [row.sessionGroup, row.count, row.syncing, row.aged]),
    [['telegram:b', 20, null, false], ['telegram:c', null, false, false]], 'the group with nothing pending is not listed');
  const failed = await createMemoryBacklog({ ...defaults, getSnapshot: async () => ({ rows, hasOlder: false }),
    groupBacklog: { many: async () => { throw new Error('reader failed'); } } })();
  assert.deepEqual(failed.groups[0], { sessionGroup: 'telegram:a', displayName: null, c4: { componentName: null },
    count: null, firstAt: null, aged: false, syncing: null, threshold: 15, reason: 'backlog_failed' });
  assert.equal(failed.groups.length, 3);
});

test('every group is read in one call, in snapshot order', async () => {
  const calls = [];
  const keys = Array.from({ length: 11 }, (_, i) => `telegram:g${i}`);
  const result = await createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: keys.map(sessionGroup => ({ sessionGroup })), hasOlder: false }),
    groupBacklog: { many: async asked => { calls.push(asked); return asked.map(() => ({ count: 1, syncing: false })); } },
  })();
  assert.deepEqual(calls, [keys]);
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
    groupBacklog: reader(group => { assert.equal(group, 'telegram:a'); return { count: ++reads, syncing: false }; }),
  });
  assert.equal((await get()).groups[0].count, 1);
  assert.equal((await get()).groups[0].count, 2);
  const empty = createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: [{ sessionGroup: null }], hasOlder: false }),
    groupBacklog: { many: async keys => { assert.deepEqual(keys, [], 'null group must not be queried'); return []; } },
  });
  assert.equal((await empty()).groups.length, 0);
});

test('group details and memory reuse exactly one thirty second backlog cache', async () => {
  let time = at, syncCalls = 0;
  const counted = { calls: 0 };
  const groupBacklog = createGroupBacklog({ zylosDir: '/isolated-zylos', now: () => time, loadPaths: markerPaths('telegram:a'),
    c4Reader: ranges(scope => { assert.equal(scope, 'telegram:a'); return { count: counted.calls, firstAt: utcText(at - 7 * 3600000) }; }, counted),
    execute: async () => { syncCalls++; return { stdout: JSON.stringify({ sync: { held: false } }) }; },
  });
  const get = createMemoryBacklog({ ...defaults, now: () => time, groupBacklog,
    getSnapshot: async () => ({ rows: [{ sessionGroup: 'telegram:a' }], hasOlder: false }),
  });
  await groupBacklog('telegram:a');
  assert.equal((await get()).groups[0].count, 1);
  time += 29999;
  await get();
  assert.equal(counted.calls, 1);
  assert.equal(syncCalls, 1);
  time++;
  assert.equal((await get()).groups[0].count, 2);
  assert.equal(counted.calls, 2);
  assert.equal(syncCalls, 2);
});

test('failed lock status keeps count and failed count keeps lock status', async () => {
  const make = failure => createGroupBacklog({ zylosDir: '/isolated-zylos', loadPaths: markerPaths('telegram:a'),
    c4Reader: ranges(() => failure === 'count' ? null : { count: 20, firstAt: null }),
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
test('memory backlog reads accept read scope while file writes require admin', async t => {
  const token = `zylos_st_${'e'.repeat(64)}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let scope = 'read';
  const gate = new AuthGate({ auth: { enabled: true, password: 'scrypt:fixture' } }, {
    getApiSession: hash => hash === tokenHash ? { api_key_id: 71, scope, expires_at: Date.now() + 60000, key_revoked_at: null } : null,
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  for (const [method, route] of [['GET', '/api/memory/backlog'], ['PUT', '/api/memory/file']]) {
    for (const pathname of [route, `/fleet/Remote${route}`, `/fleet/Remote/${route}`]) {
      const url = new URL('http://hub.test'); url.pathname = pathname;
      const request = () => ({ method, url: pathname, headers: { authorization: `Bearer ${token}` } });
      const response = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
      scope = 'read';
      assert.equal(await gate.handle(request(), response, url), method === 'PUT', pathname);
      if (method === 'PUT') {
        assert.equal(response.status, 403, pathname);
        assert.equal(response.body.error.code, 'insufficient_scope');
      }
      scope = 'admin';
      assert.equal(await gate.handle(request(), response, url), false, pathname);
    }
  }
});



// HTTP integration covers route/auth dispatch, private SQLite display names and
// the shared backlog reader. Run for route/metadata changes; skip UI-only work.
// setupMemoryHttp owns isolated resources and registers bounded teardown.
test('the backlog list, group details and the memory tree read one backlog, and the tree answers when it cannot be read', { timeout: 15000 }, async t => {
  const { root, engine, request, calls, versionCalls, snapshotReads, advance } = await setupMemoryHttp(t);
  const lockCalls = () => calls.filter(call => call.args[0].endsWith('/sync-lock.js')).map(call => call.args.slice(1));
  const snapshotBefore = snapshotReads();
  const response = await request('/api/memory/backlog');
  assert.equal(response.status, 200);
  // The test file loads the group backlog, and through it the Core runtimes, before this fixture mocks the
  // transport, so only the zylos probe is observable here.
  assert.deepEqual(versionCalls, [{ file: 'zylos', args: ['--version'] }], 'startup probes use the injected async transport');
  const startupProbes = versionCalls.length;
  assert.equal(snapshotReads(), snapshotBefore + 1, 'memory asks the snapshot service to refresh active groups');
  const value = await response.json();
  assert.equal(value.nextCursor, null);
  assert.deepEqual(value.items.map(row => [row.sessionGroup, row.count, row.firstAt, row.syncing, row.threshold]),
    [['origin', 2, '2026-10-01T12:00:00.000Z', true, 15]], 'Origin\'s own row counts its own rows and reads its own sync lock');
  assert.deepEqual(value.summary, { groups: 1, waiting: 1, aged: 1, syncing: 1, unknown: 0, threshold: 15 });
  assert.deepEqual(value.originSync, { count: 60, pendingSummaries: 2, firstAt: '2026-10-01T11:00:00.000Z',
    aged: true, syncing: false, threshold: 50 });
  assert.deepEqual(value.budgets.limits['identity.md'], BUDGETS['identity.md']);
  const detail = await request('/api/groups/origin/backlog', 'admin');
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), { count: 2, firstAt: '2026-10-01T12:00:00.000Z', syncing: true }, 'group details show the list\'s numbers');
  assert.equal(engine.store.writeGroupDisplayName('telegram:dm-1001', 'Product notes', 'human'), true);
  const original = await new MemoryBrowser({ zylosDir: root }).tree();
  const treeResponse = await request('/api/memory/tree', 'admin');
  assert.equal(treeResponse.status, 200);
  const scoped = await treeResponse.json();
  assert.deepEqual(scoped.root, original.root, 'all original tree fields stay identical');
  assert.deepEqual(Object.keys(scoped).sort(), ['root', 'sessionGroups']);
  assert.deepEqual(scoped.sessionGroups, [
    { sessionGroup: 'origin', displayName: null, backlog: { count: 2, syncing: true } },
    { sessionGroup: 'telegram:dm-1001', displayName: 'Product notes', backlog: { count: 1, syncing: false } },
  ], 'the tree carries current badges in its one answer, matching the list for Origin');
  assert.deepEqual(calls.filter(call => call.args[1] === 'unsummarized'), [], 'no count starts a process');
  assert.deepEqual(lockCalls(), [['status', '--group', 'origin', '--json'], ['status', '--group', 'origin', '--json']],
    'the cross-group row reads the Origin Sync lock; of the groups only Origin has a Sync marker, and its status is asked once for the list, details and tree (30-second cache)');
  for (const [query, code, param] of [['?limit=0', 'invalid_parameter', 'limit'], ['?cursor=forged', 'invalid_cursor', undefined]]) {
    const refused = await request('/api/memory/backlog' + query, 'admin');
    assert.equal(refused.status, 400, query);
    const body = await refused.json();
    assert.equal(body.ok, false); assert.equal(body.error.code, code); assert.equal(body.error.param, param);
  }
  assert.ok(scoped.root.children.find(node => node.path === 'session-groups').children.some(node => node.name === 'bad name'));
  // The database goes away: the tree still answers, with no count beside any group.
  fsSync.renameSync(path.join(root, 'comm-bridge/c4.db'), path.join(root, 'comm-bridge/c4.db.away'));
  advance(30000);
  const unreadable = await request('/api/memory/tree', 'admin');
  assert.equal(unreadable.status, 200);
  const blind = await unreadable.json();
  assert.deepEqual(blind.root, original.root);
  assert.deepEqual(blind.sessionGroups.map(group => group.backlog?.count ?? null), [null, null]);
  assert.equal(versionCalls.length, startupProbes, 'API reads add no version calls');
});

// Real memory and group readers; in-memory catalog/backlog adapters only.
// Run when historical name validation or shared backlog projection changes;
// skip unrelated UI changes. No subprocess, socket, database or host file access.
test('memory backlog retains historical counts without age warnings and rejects unsafe names', async () => {
  const keys = ['tg:历史-项目', 'tg:有%号', 'tg:..', 'tg:.', 'tg:群/组', 'tg:群\\组'];
  const reads = [];
  const groupBacklog = createGroupBacklog({ zylosDir: '/isolated-zylos', now: () => at,
    execute: async () => assert.fail('historical names never enter filesystem sync-lock commands'),
    loadPaths: async () => assert.fail('historical names never enter Core paths'),
    c4Reader: { getGroupBacklog: key => { reads.push(key); return { count: 21, firstAt: utcText(at - 7 * 3600000) }; },
      getUnsummarizedRanges: () => assert.fail('historical names never enter Core\'s strict calculation') },
  });
  const result = await createMemoryBacklog({ ...defaults, groupBacklog,
    getSnapshot: async () => ({ view: 'multi', rows: keys.map(sessionGroup => ({ sessionGroup })), hasOlder: false }),
  })();
  assert.deepEqual(reads, keys.slice(0, 2));
  for (const row of result.groups.slice(0, 2)) {
    assert.equal(row.count, 21); assert.equal(row.aged, false);
    assert.equal(row.firstAt, utcText(at - 7 * 3600000));
    assert.equal(row.syncing, null); assert.equal(row.reason, 'backlog_failed');
  }
  for (const row of result.groups.slice(2)) {
    assert.equal(row.count, null); assert.equal(row.firstAt, null);
    assert.equal(row.aged, false); assert.equal(row.syncing, null);
    assert.equal(row.reason, 'backlog_failed');
  }
});


test('memory backlog still warns when a syncable group has old unsummarized messages', async () => {
  const result = await createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ view: 'multi', rows: [{ sessionGroup: 'tg:current' }], hasOlder: false }),
    groupBacklog: reader(() => ({ count: 21, firstAt: utcText(at - 7 * 3600000), syncing: false })),
  })();
  assert.equal(result.groups[0].count, 21);
  assert.equal(result.groups[0].aged, true);
  assert.equal(result.groups[0].syncing, false);
});

// 120 groups: every fifth waits over six hours, every third has a pending count, every seventh is unknown, the rest
// have nothing pending. The 66 groups with a count, a wait or an unknown count are listed.
function manyGroups() {
  const values = new Map();
  for (let index = 1; index <= 120; index++) {
    const sessionGroup = `telegram:dm-${String(index).padStart(3, '0')}`;
    const unknown = index % 7 === 0, aged = index % 5 === 0, pending = aged || index % 3 === 0;
    values.set(sessionGroup, unknown ? { count: null, firstAt: null, syncing: null, reason: 'backlog_failed' }
      : { count: pending ? index % 11 + 1 : 0, firstAt: pending ? utcText(at - (aged ? 7 : 1) * 3600000 - index * 1000) : null, syncing: index === 9 });
  }
  return values;
}
async function readPages(get, base = '', limit = 50) {
  const pages = [];
  let cursor = null;
  do {
    const params = new URLSearchParams(base);
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const page = memoryBacklogPage(await get(at), parseBacklogQuery(params));
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

test('the backlog lists only groups with something to show and pages them by 50 in one order: long waits, counts, oldest, ID', async () => {
  const values = manyGroups();
  let reads = 0;
  const get = createMemoryBacklog({ ...defaults,
    getSnapshot: async () => ({ rows: [...values.keys()].reverse().map(sessionGroup => ({ sessionGroup, name: { displayName: sessionGroup === 'telegram:dm-042' ? 'Release desk' : null } })), hasOlder: false }),
    groupBacklog: { many: async keys => { reads++; assert.equal(keys.length, 120, 'every group is read'); return keys.map(key => values.get(key)); } } });
  const pages = await readPages(get);
  assert.deepEqual(pages.map(page => page.items.length), [50, 16]);
  const rows = pages.flatMap(page => page.items);
  const listed = [...values].filter(([, row]) => row.count !== 0).map(([key]) => key);
  assert.equal(listed.length, 66);
  assert.deepEqual(rows.map(row => row.sessionGroup).sort(), listed.sort(), 'every listed group once, and no group with nothing pending');
  for (let index = 1; index < rows.length; index++) {
    const [a, b] = [rows[index - 1], rows[index]];
    assert.ok((a.aged ? 0 : 1) < (b.aged ? 0 : 1) || ((a.aged === b.aged)
      && ((a.count ?? -1) > (b.count ?? -1) || ((a.count ?? -1) === (b.count ?? -1)
        && (a.firstAt === b.firstAt ? a.sessionGroup < b.sessionGroup : b.firstAt === null || (a.firstAt !== null && a.firstAt < b.firstAt))))),
      `${a.sessionGroup} before ${b.sessionGroup}`);
  }
  for (const page of pages) {
    assert.deepEqual(page.summary, { groups: 66, waiting: rows.filter(row => row.count > 0).length, aged: 21, syncing: 1,
      unknown: 17, threshold: 15 }, 'the summary covers every listed group on every page');
    assert.ok(page.budgets);
  }
  assert.equal(reads, pages.length, 'each request reads every group in one call');

  assert.deepEqual((await readPages(get, '', 22)).map(page => page.items.length), [22, 22, 22],
    'a last page that ends exactly at the limit has no next cursor');

  const found = await readPages(get, 'q=DM-04');
  assert.deepEqual(found.flatMap(page => page.items.map(row => row.sessionGroup)).sort(), ['040', '042', '045', '048', '049'].map(n => `telegram:dm-${n}`));
  const named = await readPages(get, 'q=release');
  assert.deepEqual(named[0].items.map(row => row.sessionGroup), ['telegram:dm-042'], 'the display name is searched too');
  assert.equal(named[0].summary.groups, 66);
  assert.throws(() => parseBacklogQuery(new URLSearchParams(`q=dm&cursor=${encodeURIComponent(pages[0].nextCursor)}`)), error => error.code === 'invalid_cursor',
    'a cursor belongs to its own search');
});

test('an unreadable backlog is 503 unavailable, and a refused query reads no group', async () => {
  await assert.rejects(readBacklogPage(unavailable, new URLSearchParams('limit=50')),
    error => error.statusCode === 503 && error.code === 'unavailable');
  let reads = 0;
  await assert.rejects(readBacklogPage(async () => { reads++; return { groups: [] }; }, new URLSearchParams('limit=0')),
    error => error.statusCode === 400 && error.code === 'invalid_parameter' && error.param === 'limit');
  assert.equal(reads, 0);
});
