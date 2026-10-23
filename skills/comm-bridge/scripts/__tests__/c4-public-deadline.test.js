import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

// Every case imports the public module only after setting an isolated ZYLOS_DIR.
// Slow SQL functions instrument actual SQLite statements, not returned API values.
const self = fileURLToPath(import.meta.url);
const selected = process.argv[2];
if (!selected) {
  for (const entry of ['transition', 'audit']) {
    for (const scenario of ['expired', 'wal', 'shared', 'started']) {
      test(`public ${entry}: ${scenario}`, t => {
        const child = spawnSync(process.execPath, [self, `${entry}:${scenario}`], { encoding: 'utf8', timeout: 20000 });
        t.diagnostic(child.stdout.trim());
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
      });
    }
  }
  test('public started write commits after caller deadline and independent reopen sees it', t => {
    const child = spawnSync(process.execPath, [self, 'write:started'], { encoding: 'utf8', timeout: 20000 });
    t.diagnostic(child.stdout.trim());
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
  });
} else {
  const [entry, scenario] = selected.split(':');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-public-deadline-'));
  process.env.ZYLOS_DIR = path.join(root, 'isolated');
  const filename = path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db');
  const api = await import(process.env.C4_PUBLIC_TEST_MODULE ? pathToFileURL(process.env.C4_PUBLIC_TEST_MODULE) : new URL('../c4-db.js', import.meta.url));
  const call = deadlineAt => entry === 'transition' ? api.getModeTransition({}, deadlineAt === undefined ? {} : { deadlineAt }) : api.auditCheckpoints(deadlineAt === undefined ? {} : { deadlineAt });
  let writer;
  const originalPrepare = Database.prototype.prepare;
  try {
    if (scenario === 'expired') {
      const start = performance.now();
      assert.throws(() => call(Date.now() - 1), { code: 'deadline_exceeded', persisted: [] });
      assert.equal(fs.existsSync(process.env.ZYLOS_DIR), false, 'expired public call must not initialize shared database');
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 100);
      console.log(JSON.stringify({ selected, elapsed, code: 'deadline_exceeded', directoryCreated: false }));
    } else {
      const shared = api.getDb();
      if (entry === 'write') {
        let enteredAt;
        shared.function('public_test_delay', () => { enteredAt = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); return 1; });
        shared.exec('CREATE TEMP TRIGGER public_test_delay BEFORE INSERT ON mode_transitions BEGIN SELECT public_test_delay(); END');
        const deadlineAt = Date.now() + 1000;
        const { runId } = api.beginModeTransition('single', 'multi');
        assert.ok(enteredAt < deadlineAt, 'write entered SQLite before caller deadline');
        assert.ok(Date.now() >= deadlineAt, 'write returned after caller deadline');
        api.close();
        const independent = new Database(filename, { readonly: true, fileMustExist: true });
        try {
          assert.deepEqual(independent.prepare('SELECT run_id,source_mode,target_mode,phase FROM mode_transitions').all(), [{ run_id: runId, source_mode: 'single', target_mode: 'multi', phase: 'gating' }]);
        } finally { independent.close(); }
        console.log(JSON.stringify({ selected, runId, enteredAt, deadlineAt, finishedAt: Date.now() }));
      } else {
        shared.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('fixture','single','multi','gating',1,1); INSERT INTO conversations(id,direction,channel,content,status) VALUES(7,'out','foo','x','delivered'); INSERT INTO checkpoints(id,summary,end_conversation_id,session_group,no_content) VALUES(100,'old',2000,'*',0),(101,'last',1000,'*',0)");
        const expected = entry === 'transition' ? { ...shared.prepare("SELECT * FROM mode_transitions WHERE run_id='fixture'").get(), coverage_snapshot: null, absorbed_ids: null } : [100, 101].map((checkpointId, i) => ({ checkpointId, end: i ? 1000 : 2000, maxConversationId: 7, affected: { B: 1000, coverageAll: 2000 }, repairRequired: true }));
        assert.deepEqual(call(), expected);
        const observed = new Set();
        let enteredAt, slowCalls = 0;
        Database.prototype.prepare = function(sql) {
          if (this.readonly) observed.add(this);
          if (scenario === 'started' && this.readonly && (entry === 'transition' ? sql.startsWith('SELECT * FROM mode_transitions WHERE') : sql === 'SELECT COALESCE(MAX(id),0) AS n FROM conversations')) {
            this.function('public_test_delay', () => { enteredAt = Date.now(); slowCalls++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); return 1; });
            sql = entry === 'transition' ? sql.replace(' WHERE ', ' WHERE public_test_delay()=1 AND ') : sql.replace(' AS n FROM', ' AS n, public_test_delay() AS delay FROM');
          }
          return originalPrepare.call(this, sql);
        };
        if (scenario === 'wal') {
          writer = new Database(filename);
          writer.exec("BEGIN IMMEDIATE; UPDATE mode_transitions SET reason='uncommitted'; UPDATE checkpoints SET end_conversation_id=3000; INSERT INTO conversations(id,direction,channel,content,status) VALUES(8,'out','foo','uncommitted','delivered')");
          assert.equal(writer.inTransaction, true);
          assert.equal(writer.prepare('SELECT reason FROM mode_transitions').get().reason, 'uncommitted');
          assert.equal(writer.prepare('SELECT MAX(id) AS n FROM conversations').get().n, 8);
          assert.deepEqual(writer.prepare('SELECT end_conversation_id AS n FROM checkpoints WHERE id IN (100,101) ORDER BY id').all(), [{ n: 3000 }, { n: 3000 }]);
        }
        const deadlineAt = Date.now() + 1000, start = performance.now();
        assert.deepEqual(call(deadlineAt), expected);
        const elapsed = performance.now() - start;
        assert.equal(observed.size, 1, 'public deadline call uses a dedicated readonly connection');
        assert.ok([...observed].every(db => !db.open), 'deadline connection closed');
        assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
        if (scenario === 'started') {
          assert.equal(slowCalls, 1);
          assert.ok(enteredAt < deadlineAt);
          assert.ok(Date.now() >= deadlineAt);
        } else assert.ok(elapsed < 900, `nonblocking call: ${elapsed}ms`);
        if (writer) { assert.equal(writer.inTransaction, true); writer.exec('ROLLBACK'); writer.close(); writer = undefined; }
        assert.deepEqual(call(), expected);
        assert.equal(api.getDb(), shared);
        assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
        console.log(JSON.stringify({ selected, elapsed, slowCalls, enteredAt, deadlineAt, finishedAt: Date.now(), result: expected }));
      }
    }
  } finally {
    Database.prototype.prepare = originalPrepare;
    if (writer?.open) { writer.exec('ROLLBACK'); writer.close(); }
    api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
