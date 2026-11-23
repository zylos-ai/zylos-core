import Database from 'better-sqlite3';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';

test('queue and group readers bound history work and use indexed access paths', t => {
  let trace = [], recording = false, cursorRows = 0, cursorsClosed = 0;
  const db = new Database(':memory:', { verbose: sql => { if (recording && /^\s*SELECT\b/i.test(sql)) trace.push(sql); } });
  t.after(() => db.close()); guardDatabase(db, owner);
  // Observe SQLite's public cursor boundary while executing the real statements.
  const connection = new Proxy(db, { get(target, key) {
    if (key !== 'prepare') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    return sql => {
      const statement = target.prepare(sql);
      if (!sql.includes('FROM group_heads h') || !sql.includes('ORDER BY h.head_id DESC')) return statement;
      return new Proxy(statement, { get(stmt, method) {
        if (method === 'all') return () => { assert.fail('activity reader must stream heads'); };
        if (method === 'iterate') return (...args) => {
          const cursor = stmt.iterate(...args);
          return { [Symbol.iterator]() { return this; }, next() { const item = cursor.next(); if (!item.done) cursorRows++; return item; }, return() { cursorsClosed++; return cursor.return(); } };
        };
        return typeof stmt[method] === 'function' ? stmt[method].bind(stmt) : stmt[method];
      } });
    };
  } });
  const store = createStore(connection);
  const insert = db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group,timestamp) VALUES('in','test','preview',?,?,?)");
  const head = db.prepare('INSERT INTO group_heads VALUES(?,?)');
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) head.run('old:' + i, insert.run('delivered', 'old:' + i, '2026-01-01 00:00:00').lastInsertRowid);
    for (let i = 0; i < 3; i++) head.run('recent:' + i, insert.run(i === 0 ? 'running' : 'pending', 'recent:' + i, '2026-01-30 00:00:00').lastInsertRowid);
  })();
  db.exec("INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES('fence:only','model_config','r1',1)");
  function inspect(operation) {
    trace = []; recording = true;
    let result;
    try { result = operation(); } finally { recording = false; }
    const plans = trace.map(sql => ({ sql, details: db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => row.detail) }));
    for (const { details } of plans) for (const detail of details) {
      assert.doesNotMatch(detail, /\bSCAN (?:c|conversations)\b/i);
      assert.doesNotMatch(detail, /USE TEMP B-TREE FOR ORDER BY/i);
    }
    return { result, plans };
  }
  const active = inspect(() => store.queries.listGroups({ activeSince: Date.parse('2026-01-24T00:00:00Z') }));
  assert.equal(active.result.groups.length, 3); assert.equal(active.result.hasOlder, true);
  assert.equal(cursorRows, 4); assert.ok(cursorsClosed > 0);
  const previews = plans => plans.filter(item => item.sql.includes('SELECT id,timestamp,channel,endpoint_id,content FROM conversations'));
  assert.equal(previews(active.plans).length, 3);
  const assertHeadIndex = plans => assert.ok(plans.some(plan => plan.details.some(detail => /USING INDEX idx_group_heads_head/.test(detail))), JSON.stringify(plans));
  assertHeadIndex(active.plans);
  const search = inspect(() => store.queries.listGroups({ keyMatch: 'old:', limit: 2 }));
  assert.equal(search.result.length, 2); assert.equal(previews(search.plans).length, 2);
  assert.deepEqual(search.result.map(row => row.sessionGroup), ['old:999', 'old:998']);
  assert.ok(search.plans.find(plan => plan.sql === 'SELECT session_group FROM group_heads').details.some(detail => /USING COVERING INDEX/.test(detail)));
  const queues = inspect(() => store.listGroupQueues());
  assert.equal(queues.result.groups.length, 4);
  assert.equal(queues.plans.length, 2);
  assert.ok(queues.plans.some(plan => plan.details.some(detail => /USING INDEX idx_conversations_status/.test(detail))));
  db.exec('DROP INDEX idx_group_heads_head');
  // Schema fault injection exercises the same assertion, without rewriting code.
  const withoutIndex = db.prepare('EXPLAIN QUERY PLAN SELECT h.session_group,c.timestamp FROM group_heads h JOIN conversations c ON c.id=h.head_id ORDER BY h.head_id DESC').all();
  assert.throws(() => assertHeadIndex([{ details: withoutIndex.map(row => row.detail) }]), assert.AssertionError);
});
