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

// caller budget checks and the caller-entry portion of belong to
// . These cases cover only the C4 public mode-transition read and its shared DB.
if (!selected) {
  test('records actual Node, driver and embedded SQLite versions', t => {
    const db = new Database(':memory:');
    try {
      t.diagnostic(JSON.stringify({ node: process.version,
        driver: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.resolve('better-sqlite3')))).version,
        sqlite: db.prepare('SELECT sqlite_version() AS v').get().v }));
    } finally { db.close(); }
  });
  for (const scenario of ['wal', 'shared', 'busy', 'started']) {
    test(`public transition: ${scenario}`, t => {
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', self, scenario],
        { encoding: 'utf8', timeout: 15000 });
      t.diagnostic(child.stdout.trim());
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
    });
  }
} else {
  const scenario = selected;
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
  const call = () => api.getModeTransition();
  let writer;
  assert.equal((await import('../c4-config.js')).DB_PATH, filename, 'public reader must use the isolated fixture database');
  const shared = api.getDb();
  const originalPrepare = shared.prepare, originalPragma = shared.pragma;
  const pragmaWrites = [], queryConnections = new Set(), events = [];
  try {
    shared.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('fixture','single','multi','gating',1,1)");
    const independent = new Database(filename, { readonly: true, fileMustExist: true });
    let expected;
    try {
      expected = { ...independent.prepare('SELECT * FROM mode_transitions').get(), coverage_snapshot: null, absorbed_ids: null };
    } finally { independent.close(); }
    assert.equal(opened.length, 1);
    assert.equal(opened[0], shared);
    assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
    shared.pragma = function(sql, ...args) {
      if (/=/.test(sql)) pragmaWrites.push(sql);
      return originalPragma.call(this, sql, ...args);
    };
    let injected = false, slowCalls = 0, enteredAt;
    const targetSql = sql => sql.startsWith('SELECT * FROM mode_transitions WHERE');
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
          sql = sql.replace(' WHERE ', ' WHERE public_test_delay()=1 AND ');
        }
      }
      return originalPrepare.call(this, sql, ...args);
    };
    if (scenario === 'wal') {
      // This helper also imports store/config modules: load it only after ZYLOS_DIR is set.
      const { startHeldWriter } = await import('./c4-v2-test-helpers.js');
      writer = startHeldWriter(filename, "UPDATE mode_transitions SET reason='new-committed'");
      const [held] = await writer.held;
      assert.deepEqual(held, { mode: 'normal', journal: 'wal', inTransaction: true });
      events.push({ event: 'writer-held', ...held });
    }
    const localBudgetExpiresAt = Date.now() + 1000, start = performance.now();
    if (scenario === 'busy') {
      assert.throws(call, { code: 'DB_BUSY', persisted: [] });
      assert.equal(injected, true, 'controlled busy injection reached the driver edge');
      assert.equal(shared.inTransaction, false, 'read transaction rolls back on failure');
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
      expected = { ...expected, reason: 'new-committed' };
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
