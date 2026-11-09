import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';

test('queue summaries include fenced and running groups but exclude terminal history', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queues-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');
  const db = new Database(file); t.after(() => db.close());
  guardDatabase(db, owner);
  const seed = db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group,priority,timestamp) VALUES(?,'in','test','x',?,?,?,?)");
  seed.run(10, 'pending', 'test:A', 2, '2026-01-01 00:00:00');
  seed.run(12, 'pending', 'test:A', 1, '2026-01-02T00:00:00Z');
  seed.run(13, 'running', 'test:A', 3, '2026-01-03 00:00:00');
  seed.run(14, 'pending', 'test:B', 3, '2026-01-04 00:00:00');
  seed.run(15, 'running', 'test:D', 3, '2026-01-05 00:00:00');
  seed.run(16, 'pending', 'origin', 3, '2026-01-06 00:00:00');
  seed.run(17, 'failed', 'test:A', 1, '2026-01-01 00:00:00');
  seed.run(18, 'delivered', 'test:A', 1, '2026-01-01 00:00:00');
  seed.run(19, 'pending', '', 1, '2026-01-01 00:00:00');
  db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out','test','out','pending','test:out')").run();
  db.transaction(() => { for (let i = 0; i < 1000; i++) seed.run(100 + i, 'delivered', 'old:' + i, 3, '2026-01-01 00:00:00'); })();
  const fence = db.prepare('INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES(?,?,?,?)');
  fence.run('test:B', 'ttl', 'r1', 100);
  fence.run('test:C', 'model_config', 'r2', 101);
  const store = createStore(db);
  assert.ok(!store.listPendingSessionGroups().some(row => row.sessionGroup === 'test:B'));
  fence.run('*', null, null, 102);
  const observer = new Database(file); t.after(() => observer.close());
  const version = observer.pragma('data_version', { simple: true });
  const bytes = fs.readFileSync(file);
  const result = store.listGroupQueues();
  assert.deepEqual(result.groups.map(row => row.sessionGroup), ['origin', 'test:A', 'test:B', 'test:C', 'test:D']);
  const group = name => result.groups.find(row => row.sessionGroup === name);
  assert.deepEqual(group('test:A'), { sessionGroup: 'test:A', pending: { count: 2, oldestAt: Date.parse('2026-01-01T00:00:00Z'), head: { id: 12, priority: 1 } }, running: { count: 1 }, fence: null });
  assert.equal(group('test:B').pending.count, 1);
  assert.deepEqual(group('test:B').fence, { sessionGroup: 'test:B', reason: 'ttl', runId: 'r1', createdAt: 100 });
  assert.deepEqual(group('test:C').pending, { count: 0, oldestAt: null, head: null });
  assert.equal(group('test:C').fence.reason, 'model_config');
  assert.equal(group('test:D').running.count, 1);
  assert.equal(group('test:D').pending.count, 0);
  assert.deepEqual(result.globalFence, { sessionGroup: '*', reason: null, runId: null, createdAt: 102 });
  assert.equal(observer.pragma('data_version', { simple: true }), version);
  assert.deepEqual(fs.readFileSync(file), bytes);
  db.prepare("UPDATE drain_fences SET reason='manual_restart',run_id='r9' WHERE session_group='*'").run();
  assert.deepEqual(store.listGroupQueues().globalFence, { sessionGroup: '*', reason: 'manual_restart', runId: 'r9', createdAt: 102 });
  seed.run(9, 'pending', 'test:A', 1, '2026-01-02 00:00:00');
  assert.deepEqual(store.listGroupQueues().groups.find(row => row.sessionGroup === 'test:A').pending.head, { id: 9, priority: 1 });
});

test('empty summaries and fence-only global state retain their shapes', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  const store = createStore(db);
  assert.deepEqual(store.listGroupQueues(), { groups: [], globalFence: null });
  db.exec("INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES('*',NULL,NULL,1)");
  assert.deepEqual(store.listGroupQueues(), { groups: [], globalFence: { sessionGroup: '*', reason: null, runId: null, createdAt: 1 } });
});

test('queue rows and fences share one snapshot while another connection writes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');
  let writer, interleave = false;
  const db = new Database(file, { verbose(sql) {
    if (interleave && sql.startsWith('SELECT session_group AS sessionGroup,reason')) {
      interleave = false;
      writer.transaction(() => {
        writer.exec("UPDATE conversations SET status='delivered'; DELETE FROM drain_fences");
      })();
    }
  } });
  t.after(() => db.close()); db.pragma('journal_mode=WAL'); guardDatabase(db, owner);
  db.exec("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','test','x','pending','test:A'); INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES('test:A','ttl','r1',1)");
  writer = new Database(file); t.after(() => writer.close());
  const store = createStore(db);
  interleave = true;
  const during = store.listGroupQueues();
  assert.equal(interleave, false);
  assert.equal(during.groups[0].pending.count, 1);
  assert.equal(during.groups[0].fence.reason, 'ttl');
  assert.deepEqual(store.listGroupQueues(), { groups: [], globalFence: null });
});

test('queue groups use binary key ordering', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  db.exec("INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES('test:a','model_config','r1',1),('test:Z','model_config','r2',1)");
  assert.deepEqual(createStore(db).listGroupQueues().groups.map(row => row.sessionGroup), ['test:Z', 'test:a']);
});
