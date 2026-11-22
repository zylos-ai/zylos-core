import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../comm-bridge/scripts/c4-schema.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { createGroupBacklog } from '../src/lib/workbench/group-backlog.js';
import { createMemoryBacklog, memoryBacklogPage, parseBacklogQuery } from '../src/lib/workbench/memory-backlog.js';

// The real group reader over a private C4 database with Core's schema, Core's own unsummarized calculation and
// Core's run-directory paths; only the sync-lock status child is an injected, counted answer. Run under the
// official runner (private HOME, ZYLOS_DIR, TMPDIR). Teardown closes the databases and removes the directory.
const at = Date.UTC(2026, 10, 20, 12);
const group = index => `telegram:g${String(index).padStart(3, '0')}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-backlog-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  guardDatabase(db, c4Schema);
  const reader = new C4Reader(root);
  t.after(() => { reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let id = 0;
  const message = (sessionGroup, minutesAgo) => db.prepare(`INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group,timestamp)
    VALUES(?,'in','telegram','e','m','delivered',?,?)`).run(++id, sessionGroup, new Date(at - minutesAgo * 60000).toISOString().slice(0, 19).replace('T', ' '));
  const checkpoint = sessionGroup => db.prepare("INSERT INTO checkpoints(summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES('s',1,?,?,0)").run(id, sessionGroup);
  const marker = sessionGroup => {
    fs.mkdirSync(path.join(root, 'activity-monitor/session-groups', sessionGroup), { recursive: true });
    fs.writeFileSync(path.join(root, 'activity-monitor/session-groups', sessionGroup, 'sync.lock'), '{}');
  };
  return { root, db, reader, message, checkpoint, marker };
}

test('two hundred groups are counted in one database read; only the group with a Sync marker asks for its status, and only groups with something to show are listed', async t => {
  const f = fixture(t);
  // Every group has a summarized message; groups 1-30 then get 1-30 new ones. Group 200 has a Sync marker.
  for (let index = 1; index <= 200; index++) { f.message(group(index), 600); f.checkpoint(group(index)); }
  for (let index = 1; index <= 30; index++) for (let n = 0; n < index; n++) f.message(group(index), 60 - n);
  f.marker(group(200));
  const execs = [], snapshots = [];
  const c4Reader = Object.assign(Object.create(f.reader), {
    getUnsummarizedRanges: (scopes, options) => { snapshots.push(scopes.length); return f.reader.getUnsummarizedRanges(scopes, options); },
  });
  const groupBacklog = createGroupBacklog({ zylosDir: f.root, c4Reader, readConfig: () => ({ state: 'missing' }), now: () => at,
    execute: async (file, args) => { execs.push(args.slice(1)); return { stdout: JSON.stringify({ sync: { held: true } }) }; } });
  const read = createMemoryBacklog({ zylosDir: f.root, readConfig: async () => ({}), env: {}, now: () => at, groupBacklog,
    getSnapshot: async () => ({ view: 'multi', rows: Array.from({ length: 200 }, (_, index) => ({ sessionGroup: group(index + 1) })) }) });
  const page = memoryBacklogPage(await read(at), parseBacklogQuery(new URLSearchParams('limit=100')));
  assert.deepEqual(snapshots, [200], 'one call reads every group');
  assert.deepEqual(execs, [['status', '--group', group(200), '--json']], 'no count starts a process; one status check for the one marker');
  assert.equal(page.items.length, 31);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.items.slice(0, 30).map(row => [row.sessionGroup, row.count]),
    Array.from({ length: 30 }, (_, index) => [group(30 - index), 30 - index]), 'by pending count');
  assert.deepEqual(page.items[30], { sessionGroup: group(200), displayName: null, c4: { componentName: null }, count: 0, firstAt: null,
    aged: false, syncing: true, threshold: 15 }, 'a running Sync is listed with nothing pending');
  assert.deepEqual(page.summary, { groups: 31, waiting: 30, aged: 0, syncing: 1, unknown: 0, threshold: 15 });
  assert.equal(page.items[0].firstAt, new Date(at - 60 * 60000).toISOString().slice(0, 19).replace('T', ' '));
  // Group details and the memory tree use the same reader within thirty seconds: nothing is read again.
  assert.deepEqual(await groupBacklog(group(200)), { count: 0, firstAt: null, syncing: true });
  assert.deepEqual((await groupBacklog.many([group(1), group(150)])).map(value => value.count), [1, 0]);
  assert.deepEqual([snapshots.length, execs.length], [1, 1]);
});

test('one group that cannot be read is listed as failed and the other groups read normally', async t => {
  const f = fixture(t);
  for (const index of [1, 2, 3]) f.message(group(index), 30);
  f.marker(group(3));
  const scopes = [];
  const c4Reader = Object.assign(Object.create(f.reader), {
    // Core's range for group 2 fails inside the shared snapshot.
    getUnsummarizedRanges: (asked, options) => { scopes.push(...asked); return f.reader.getUnsummarizedRanges(asked.map(scope => scope === group(2) ? 'not a group!' : scope), options); },
  });
  const groupBacklog = createGroupBacklog({ zylosDir: f.root, c4Reader, readConfig: () => ({ state: 'missing' }), now: () => at,
    execute: async () => { throw new Error('status failed'); } });
  assert.deepEqual(await groupBacklog.many([group(1), group(2), group(3), group(4)]), [
    { count: 1, firstAt: new Date(at - 30 * 60000).toISOString().slice(0, 19).replace('T', ' '), syncing: false },
    { count: null, firstAt: null, syncing: false, reason: 'backlog_failed' },
    { count: 1, firstAt: new Date(at - 30 * 60000).toISOString().slice(0, 19).replace('T', ' '), syncing: null, reason: 'backlog_failed' },
    { count: 0, firstAt: null, syncing: false },
  ], 'a failed count and a failed status each mark only their own group');
  assert.deepEqual(scopes, [group(1), group(2), group(3), group(4)]);
  // A package without zylos-memory: counts are read, each Sync status is unknown and the group is marked failed.
  const noLock = createGroupBacklog({ zylosDir: f.root, c4Reader: f.reader, readConfig: () => ({ state: 'missing' }), now: () => at,
    loadSyncLock: async () => { throw Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }); },
    execute: async () => assert.fail('no status without the sync-lock module') });
  assert.deepEqual(await noLock.many([group(1)]), [{ count: 1, firstAt: new Date(at - 30 * 60000).toISOString().slice(0, 19).replace('T', ' '), syncing: null, reason: 'backlog_failed' }]);
  // Without the database every count is unknown, and the tree's reader still answers.
  fs.renameSync(path.join(f.root, 'comm-bridge/c4.db'), path.join(f.root, 'comm-bridge/c4.db.away'));
  const blind = createGroupBacklog({ zylosDir: f.root, c4Reader: f.reader, readConfig: () => ({ state: 'missing' }), now: () => at,
    execute: async () => assert.fail('no marker, no status') });
  assert.deepEqual(await blind.many([group(1)]), [{ count: null, firstAt: null, syncing: false, reason: 'backlog_failed' }]);
});
