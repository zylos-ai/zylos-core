import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const self = fileURLToPath(import.meta.url);
const selected = process.argv[2];

// IF-65 caller budget checks (②) and the caller-entry portion of ⑤ belong to
// P05/P11. These cases cover only the two C4 public reads and their shared DB.
if (!selected) {
  test('IF-65 records actual Node, driver and embedded SQLite versions', t => {
    const db = new Database(':memory:');
    try {
      t.diagnostic(JSON.stringify({ node: process.version,
        driver: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.resolve('better-sqlite3')))).version,
        sqlite: db.prepare('SELECT sqlite_version() AS v').get().v }));
    } finally { db.close(); }
  });
  for (const entry of ['transition', 'audit']) {
    for (const scenario of ['wal', 'shared', 'busy', 'started']) {
      test(`IF-65 public ${entry}: ${scenario}`, t => {
        const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', self, `${entry}:${scenario}`],
          { encoding: 'utf8', timeout: 15000 });
        t.diagnostic(child.stdout.trim());
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
      });
    }
  }
} else {
  const [entry, scenario] = selected.split(':');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-shared-read-'));
  process.env.ZYLOS_DIR = path.join(root, 'isolated');
  const filename = path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db');
  const opened = [];
  // The wrapper observes real driver constructors without replacing SQLite.
  function TrackedDatabase(...args) {
    const connection = new Database(...args);
    opened.push(connection);
    return connection;
  }
  TrackedDatabase.prototype = Database.prototype;
  mock.module('better-sqlite3', { defaultExport: TrackedDatabase });
  const api = await import(new URL('../c4-db.js', import.meta.url));
  const call = () => entry === 'transition' ? api.getModeTransition() : api.auditCheckpoints();
  let writer;
  assert.equal((await import('../c4-config.js')).DB_PATH, filename, 'public reader must use the isolated fixture database');
  const shared = api.getDb();
  const originalPrepare = shared.prepare, originalPragma = shared.pragma;
  const pragmaWrites = [], queryConnections = new Set(), events = [];
  try {
    shared.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('fixture','single','multi','gating',1,1); INSERT INTO conversations(id,direction,channel,content,status) VALUES(7,'out','foo','x','delivered'); INSERT INTO checkpoints(id,summary,end_conversation_id,session_group,no_content) VALUES(100,'old',2000,'*',0),(101,'last',1000,'*',0)");
    const independent = new Database(filename, { readonly: true, fileMustExist: true });
    let expected;
    try {
      expected = entry === 'transition'
        ? { ...independent.prepare('SELECT * FROM mode_transitions').get(), coverage_snapshot: null, absorbed_ids: null }
        : [100, 101].map((checkpointId, i) => ({ checkpointId, end: i ? 1000 : 2000, maxConversationId: 7,
          affected: { B: 1000, coverageAll: 2000 }, repairRequired: true }));
    } finally { independent.close(); }
    assert.equal(opened.length, 1);
    assert.equal(opened[0], shared);
    assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
    shared.pragma = function(sql, ...args) {
      if (/=/.test(sql)) pragmaWrites.push(sql);
      return originalPragma.call(this, sql, ...args);
    };
    let injected = false, slowCalls = 0, enteredAt;
    const targetSql = sql => entry === 'transition' ? sql.startsWith('SELECT * FROM mode_transitions WHERE')
      : sql === 'SELECT COALESCE(MAX(id),0) AS n FROM conversations';
    shared.prepare = function(sql, ...args) {
      queryConnections.add(this);
      if (targetSql(sql) && !injected) {
        if (scenario === 'busy') {
          injected = true;
          throw Object.assign(new Error('controlled driver busy'), { code: 'SQLITE_BUSY' });
        }
        if (scenario === 'started') {
          injected = true;
          this.function('public_test_delay', () => {
            enteredAt = Date.now(); slowCalls++;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
            return 1;
          });
          sql = entry === 'transition' ? sql.replace(' WHERE ', ' WHERE public_test_delay()=1 AND ')
            : sql.replace(' AS n FROM', ' AS n, public_test_delay() AS delay FROM');
        }
      }
      return originalPrepare.call(this, sql, ...args);
    };
    if (scenario === 'wal') {
      // This helper also imports store/config modules: load it only after ZYLOS_DIR is set.
      const { startHeldWriter } = await import('./c4-v2-test-helpers.js');
      writer = startHeldWriter(filename, "UPDATE mode_transitions SET reason='new-committed'; UPDATE checkpoints SET end_conversation_id=3000 WHERE id IN (100,101); INSERT INTO conversations(id,direction,channel,content,status) VALUES(8,'out','foo','new-committed','delivered')");
      const [held] = await writer.held;
      assert.deepEqual(held, { mode: 'normal', journal: 'wal', inTransaction: true });
      events.push({ event: 'writer-held', ...held });
    }
    const localBudgetExpiresAt = Date.now() + 1000, start = performance.now();
    if (scenario === 'busy') {
      assert.throws(call, { code: 'DB_BUSY', persisted: [] });
      assert.equal(injected, true, 'controlled busy injection reached the driver edge');
      assert.equal(shared.inTransaction, false, 'audit read transaction rolls back on failure');
    } else assert.deepEqual(call(), expected);
    const elapsed = performance.now() - start;
    if (scenario === 'started') {
      assert.equal(slowCalls, 1);
      assert.ok(enteredAt < localBudgetExpiresAt);
      assert.ok(Date.now() >= localBudgetExpiresAt);
      assert.ok(elapsed >= 2000, `query body completes: ${elapsed}ms`);
    }
    if (writer) {
      assert.equal(writer.child.exitCode, null, 'writer remains held until read completes');
      events.push({ event: 'read-completed-before-commit', elapsed });
      writer.child.send('commit');
      const [code, signal] = await writer.exited;
      assert.equal(code, 0); assert.equal(signal, null); writer = undefined;
      events.push({ event: 'writer-committed-and-exited', code });
      expected = entry === 'transition' ? { ...expected, reason: 'new-committed' }
        : expected.map(row => ({ ...row, end: 3000, maxConversationId: 8, affected: { B: 3000, coverageAll: 3000 } }));
    }
    assert.deepEqual(call(), expected, 'fresh read sees committed values / read recovers after controlled busy');
    assert.equal(api.getDb(), shared);
    assert.equal(opened.length, 1, 'public reads must not open another connection');
    assert.deepEqual([...queryConnections], [shared], 'queries execute on the shared connection');
    assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
    assert.deepEqual(pragmaWrites, [], 'ordinary reads must not mutate shared PRAGMA');
    console.log(JSON.stringify({ selected, elapsed, controlledDriver: scenario === 'busy', slowCalls,
      enteredAt, localBudgetExpiresAt, finishedAt: Date.now(), openedConnections: opened.length, busyTimeout: 5000, events, result: expected }));
  } finally {
    shared.prepare = originalPrepare; shared.pragma = originalPragma;
    if (writer && writer.child.exitCode === null && writer.child.signalCode === null) { writer.child.kill(); await writer.exited; }
    api.close(); mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true });
  }
}
