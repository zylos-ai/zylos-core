import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../../../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../../store.js';
import { C4Reader } from '../../c4-reader.js';
import { createRuns } from '../runs.js';
import { readTimelineEvents } from '../timeline-events.js';

const query = values => new URLSearchParams(values);
const group = 'telegram:fixture';

test('group timelines seek in both directions and suppress restart exits before paging', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const insert = (id, type, seconds, run = 'run-a') => store.insertEvent({ id, ingest_id: id, event_type: type,
    timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)).toISOString(), run_id: run, session_group: group, category: 'fixture' });
  insert('restart', 'tool_timeout_restart', 0);
  insert('exit', 'crash_detected', 10);
  insert('interrupted', 'post_tool_failure', 9);
  insert('run-b', 'session_start', 0, 'run-b');
  const runs = createRuns({ store });
  const first = await runs(group, query({ limit: 1 }));
  assert.deepEqual(first.items.map(row => [row.runId, row.n]), [['run-a', 2]]);
  const second = await runs(group, query({ limit: 1, cursor: first.nextCursor }));
  assert.deepEqual(second.items.map(row => row.runId), ['run-b']);
  assert.equal(second.nextCursor, null);
  const read = values => readTimelineEvents(store, group, false, query(values), rows => rows);
  const firstEvents = await read({ runId: 'run-a', limit: 1 });
  assert.deepEqual(firstEvents.items.map(row => [row.id, row.interrupted]), [['interrupted', true]]);
  assert.deepEqual((await read({ runId: 'run-a', cursor: firstEvents.nextCursor })).items.map(row => row.id), ['restart']);
  await assert.rejects(read({ runId: 'run-a', filter: 'tools', cursor: firstEvents.nextCursor }), { code: 'invalid_cursor' });
  const tools = await read({ runId: 'run-a', filter: 'tools', limit: 1 });
  assert.deepEqual(tools.items.map(row => [row.id, row.interrupted]), [['interrupted', true]]);
  assert.equal(tools.nextCursor, null);
  assert.deepEqual((await read({ runId: 'run-a', filter: 'lifecycle' })).items.map(row => row.id), ['restart']);
  for (const [parameters, param] of [['offset=1', 'offset'], ['session_group=x', 'session_group'], ['since=x', 'since'],
    ['limit=0', 'limit'], ['limit=1&limit=2', 'limit'], ['filter=foo', 'filter']]) {
    await assert.rejects(read(parameters), { code: 'invalid_parameter', param });
  }
  insert('ordinary', 'post_tool_failure', 11);
  const appended = await read({ runId: 'run-a', direction: 'after', cursor: firstEvents.afterCursor });
  assert.deepEqual(appended.items.map(row => [row.id, row.interrupted]), [['ordinary', undefined]]);
  const empty = await read({ runId: 'run-a', direction: 'after', cursor: appended.afterCursor });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.afterCursor, appended.afterCursor);
});

test('group message pages project only metadata and preserve a polling position', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-c4-'));
  const reader = new C4Reader(root);
  t.after(() => { reader.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => reader.getGroupMessagePage(group, query()), { statusCode: 503, code: 'unavailable' });
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  try {
    db.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT, direction TEXT, channel TEXT, timestamp TEXT, content TEXT)');
    const put = db.prepare("INSERT INTO conversations VALUES(?, ?, 'in', ?, '2026-10-01 00:00:00', 'fixture body')");
    for (let id = 1; id <= 300; id++) put.run(id, group, 'telegram');
    put.run(301, group, 'internal');
    const newest = reader.getGroupMessagePage(group, query({ limit: 100 }));
    const ids = newest.items.map(row => row.id);
    for (let cursor = newest.nextCursor; cursor;) {
      const page = reader.getGroupMessagePage(group, query({ limit: 100, cursor }));
      ids.unshift(...page.items.map(row => row.id));
      cursor = page.nextCursor;
    }
    assert.deepEqual(ids, Array.from({ length: 300 }, (_, index) => index + 1));
    assert.deepEqual(Object.keys(newest.items[0]), ['id', 'direction', 'channel', 'timestamp']);
    put.run(302, group, 'telegram');
    assert.deepEqual(reader.getGroupMessagePage(group, query({ direction: 'after', cursor: newest.afterCursor })).items.map(row => row.id), [302]);
  } finally { db.close(); }
});
