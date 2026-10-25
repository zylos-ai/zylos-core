import Database from 'better-sqlite3';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';

function assertIndexed(plans) {
  const details = plans.flatMap(plan => plan.details);
  assert.ok(details.some(detail => /USING (?:COVERING )?INDEX|USING INTEGER PRIMARY KEY/.test(detail)), 'query must have an indexed access path: ' + JSON.stringify(plans));
  for (const detail of details) {
    // Candidate heads are intentionally enumerated; the historical message,
    // control and checkpoint tables must not be scanned without an index.
    assert.doesNotMatch(detail, /\bSCAN (?:conversations|control_queue|checkpoints|c|p)\b(?! USING (?:COVERING )?INDEX)/i);
  }
}

test('query plans use indexes without compiler instrumentation or native extensions', t => {
  let trace = [], recording = false;
  const db = new Database(':memory:', { verbose: sql => { if (recording && /^\s*(?:SELECT|WITH)\b/i.test(sql)) trace.push(sql); } });
  t.after(() => db.close());
  guardDatabase(db, owner);
  const store = createStore(db);
  function inspect(operation) {
    trace = []; recording = true;
    let result;
    try { result = operation(); } finally { recording = false; }
    const statements = [...trace];
    const plans = statements.map(sql => ({ sql, details: db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => row.detail) }));
    assertIndexed(plans);
    return { result, plans };
  }
  const seed = db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,'in','test','x',?,?)");
  const controls = db.prepare("INSERT INTO control_queue(raw_content,content,status,session_group,created_at,updated_at) VALUES('x','x',?,?,1,1)");
  function history(start, end, groups) {
    db.transaction(() => {
      for (let id = start; id <= end; id++) {
        seed.run(id, 'delivered', 'old' + id % groups);
        controls.run('done', 'old' + id % groups);
      }
    })();
  }
  history(1, 2000, 500);
  db.transaction(() => {
    for (let id = 1; id <= 20; id++) {
      seed.run(1000000 + id, id <= 10 ? 'pending' : 'delivered', id <= 10 ? 'pending' : 'active');
    }
    for (const group of [null, 'active', 'other']) {
      for (const status of ['pending', 'running']) controls.run(status, group);
    }
  })();
  db.prepare("INSERT INTO checkpoints(summary,end_conversation_id,session_group) VALUES('baseline',100000,'*')").run();
  function measure() {
    const operations = {
      machine: () => store.countNonTerminalControls({ machine: true }),
      group: () => store.countNonTerminalControls({ sessionGroup: 'active' }),
      all: () => store.countNonTerminalControls({ allSessionGroups: true }),
      pending: () => store.listPendingSessionGroups(),
      tail: () => store.getGlobalDeliveredSince(100000, { limit: 5 }),
      range: () => store.getUnsummarizedRange('active'),
    };
    return Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, inspect(operation)]));
  }
  const first = measure();
  history(2001, 4000, 1000);
  const second = measure();
  for (const name of ['machine', 'group', 'all', 'pending', 'tail', 'range']) {
    assert.deepEqual(second[name].result, first[name].result, name);
  }
  assert.deepEqual(first.tail.result.map(row => row.id), [1000016, 1000017, 1000018, 1000019, 1000020]);
  assert.equal(first.range.result.count, 10);
  for (const name of Object.keys(first)) {
    t.diagnostic(JSON.stringify({ operation: name, plans: second[name].plans }));
  }

  // Three candidates, including a group with only a new summary. Silent heads
  // may grow the candidate scan, but must not cause per-group detail queries.
  const head = db.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?)');
  const cursor = db.prepare('INSERT INTO origin_sync_cursors(session_group,synced_id,checkpoint_id,updated_at) VALUES(?,?,0,1)');
  function silentHeads(start, end) {
    db.transaction(() => {
      for (let id = start; id <= end; id++) {
        head.run('silent' + id, id);
        cursor.run('silent' + id, id);
      }
    })();
  }
  silentHeads(1, 500);
  head.run('active', 1000020);
  seed.run(1000021, 'delivered', 'fresh');
  head.run('fresh', 1000021);
  seed.run(1000022, 'delivered', 'summary');
  head.run('summary', 1000022);
  cursor.run('summary', 1000022);
  db.prepare("INSERT INTO checkpoints(summary,end_conversation_id,session_group) VALUES('new',1000022,'summary')").run();
  function originCost() {
    const { result, plans } = inspect(() => store.getOriginSyncBacklog());
    const details = plans.filter(item => !item.sql.includes('FROM group_heads h'));
    return { result, plans: details, statements: details.length };
  }
  const originFirst = originCost();
  silentHeads(501, 1000);
  const originSecond = originCost();
  assert.deepEqual(originFirst.result.groups.map(group => group.sessionGroup), ['active', 'fresh', 'summary']);
  assert.deepEqual(originSecond, originFirst);
  t.diagnostic(JSON.stringify({ operation: 'Origin detail queries', statements: originSecond.statements, plans: originSecond.plans }));
  const negative = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM conversations NOT INDEXED WHERE content='missing'").all().map(row => row.detail);
  assert.ok(negative.some(detail => detail === 'SCAN conversations'));
  assert.throws(() => assertIndexed([{ details: negative }]), assert.AssertionError, 'known full-table scan must fail the same plan assertion');
});
