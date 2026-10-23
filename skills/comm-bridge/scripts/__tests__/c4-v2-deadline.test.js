import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import Database from 'better-sqlite3';

// Every case imports the public module only after setting an isolated ZYLOS_DIR.
// Slow SQL functions instrument actual SQLite statements, not returned API values.
const self = fileURLToPath(import.meta.url);
const selected = process.argv[2];
if (!selected) {
  test('IF-65 records actual Node, driver and embedded SQLite versions', t => {
    const db = new Database(':memory:');
    try { t.diagnostic(JSON.stringify({ node: process.version, driver: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.resolve('better-sqlite3')))).version, sqlite: db.prepare('SELECT sqlite_version() AS v').get().v })); }
    finally { db.close(); }
  });
  for (const entry of ['transition', 'audit']) {
    for (const scenario of ['short', 'expired', 'ordinary', 'cap', 'released', 'wal', 'shared', 'started']) {
      test(`IF-65 public ${entry}: ${scenario}`, t => {
        const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', self, `${entry}:${scenario}`], { encoding: 'utf8', timeout: 20000 });
        t.diagnostic(child.stdout.trim());
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
      });
    }
  }
  test('IF-65 public started write commits after caller deadline and independent reopen sees it', t => {
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', self, 'write:started'], { encoding: 'utf8', timeout: 20000 });
    t.diagnostic(child.stdout.trim());
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
  });
} else {
  const [entry, scenario] = selected.split(':');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-public-deadline-'));
  process.env.ZYLOS_DIR = path.join(root, 'isolated');
  const filename = path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db');
  const controlled = ['short', 'ordinary', 'cap', 'released'].includes(scenario);
  if (controlled) await controlledCase(entry, scenario, filename, root);
  else {
    const api = await import(process.env.C4_PUBLIC_TEST_MODULE ? pathToFileURL(process.env.C4_PUBLIC_TEST_MODULE) : new URL('../c4-db.js', import.meta.url));
    const call = deadlineAt => entry === 'transition' ? api.getModeTransition({}, deadlineAt === undefined ? {} : { deadlineAt }) : api.auditCheckpoints(deadlineAt === undefined ? {} : { deadlineAt });
    let writer;
    const walEvents = [];
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
            const source = `import Database from ${JSON.stringify(require.resolve('better-sqlite3'))};
              const db = new Database(process.argv[1]);
              db.exec("BEGIN IMMEDIATE; UPDATE mode_transitions SET reason='new-committed'; UPDATE checkpoints SET end_conversation_id=3000 WHERE id IN (100,101); INSERT INTO conversations(id,direction,channel,content,status) VALUES(8,'out','foo','new-committed','delivered')");
              process.send({ mode: db.pragma('locking_mode', { simple: true }), journal: db.pragma('journal_mode', { simple: true }), inTransaction: db.inTransaction });
              process.on('message', () => { db.exec('COMMIT'); db.close(); process.exit(0); });`;
            const child = spawn(process.execPath, ['--input-type=module', '-e', source, filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            let stderr = ''; child.stderr.on('data', data => { stderr += data; });
            const exited = once(child, 'exit');
            writer = { child, exited };
            const [locked] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`writer exited before barrier: ${stderr}`); })]);
            assert.deepEqual(locked, { mode: 'normal', journal: 'wal', inTransaction: true });
            walEvents.push({ event: 'writer-held', ...locked });
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
          if (writer) {
            assert.equal(writer.child.exitCode, null, 'writer remains held until read completes');
            walEvents.push({ event: 'read-completed-before-commit', elapsed });
            writer.child.send('commit');
            const [code, signal] = await writer.exited;
            assert.equal(code, 0); assert.equal(signal, null); writer = undefined;
            walEvents.push({ event: 'writer-committed-and-exited', code });
            const committed = entry === 'transition' ? { ...expected, reason: 'new-committed' }
              : expected.map(row => ({ ...row, end: 3000, maxConversationId: 8, affected: { B: 3000, coverageAll: 3000 } }));
            assert.deepEqual(call(Date.now() + 1000), committed, 'fresh deadline read sees committed writer values');
            assert.deepEqual(call(), committed, 'shared reader also sees the committed snapshot');
          } else assert.deepEqual(call(), expected);
          assert.equal(api.getDb(), shared);
          assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
          console.log(JSON.stringify({ selected, elapsed, slowCalls, enteredAt, deadlineAt, finishedAt: Date.now(), walEvents, result: expected }));
        }
      }
    } finally {
      Database.prototype.prepare = originalPrepare;
      if (writer && writer.child.exitCode === null && writer.child.signalCode === null) { writer.child.kill(); await writer.exited; }
      api.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

// Only the private driver opening and wall clock are controlled. Public API,
// owner inspection, timeout arithmetic, error mapping and finally stay real.
// These cases provide no evidence of actual SQLite lock-wait latency.
async function controlledCase(entry, scenario, filename, root) {
  let clock = 100000, waited = false;
  const opened = [], timeouts = [], events = [];
  const busy = () => Object.assign(new Error('controlled native wait stopped'), { code: 'SQLITE_BUSY' });
  const open = (file, options) => {
    events.push({ event: 'open', options: { ...options } });
    const connection = new Database(file, options); opened.push(connection);
    const nativePragma = connection.pragma;
    connection.pragma = function(sql, ...args) {
      if (/^busy_timeout\s*=/i.test(sql)) timeouts.push(Number(sql.split('=')[1]));
      if (sql === 'user_version' && !waited) {
        waited = true;
        const timeout = nativePragma.call(this, 'busy_timeout', { simple: true });
        events.push({ event: 'driver-wait', timeout, clock });
        if (scenario === 'released') clock += 2000;
        else { clock += timeout; throw busy(); }
      }
      return nativePragma.call(this, sql, ...args);
    };
    return connection;
  };
  const apiURL = process.env.C4_PUBLIC_TEST_MODULE ? pathToFileURL(process.env.C4_PUBLIC_TEST_MODULE) : new URL('../c4-db.js', import.meta.url);
  const helperURL = new URL('./c4-deadline-read.js', apiURL);
  const { withDeadlineRead: realDeadlineRead } = await import(helperURL.href);
  mock.module(helperURL.href, { namedExports: {
    withDeadlineRead: (...args) => realDeadlineRead(...args, { now: () => clock, open }),
  } });
  const api = await import(process.env.C4_PUBLIC_TEST_MODULE ? pathToFileURL(process.env.C4_PUBLIC_TEST_MODULE) : new URL('../c4-db.js', import.meta.url));
  const call = deadlineAt => entry === 'transition' ? api.getModeTransition({}, deadlineAt === undefined ? {} : { deadlineAt }) : api.auditCheckpoints(deadlineAt === undefined ? {} : { deadlineAt });
  const shared = api.getDb();
  const originalPrepare = shared.prepare, originalExec = shared.exec;
  try {
    shared.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('fixture','single','multi','gating',1,1); INSERT INTO conversations(id,direction,channel,content,status) VALUES(7,'out','foo','x','delivered'); INSERT INTO checkpoints(id,summary,end_conversation_id,session_group,no_content) VALUES(100,'old',2000,'*',0),(101,'last',1000,'*',0)");
    const independent = new Database(filename, { readonly: true, fileMustExist: true });
    let expected;
    try {
      expected = entry === 'transition'
        ? { ...independent.prepare('SELECT * FROM mode_transitions').get(), coverage_snapshot: null, absorbed_ids: null }
        : [100, 101].map((checkpointId, i) => ({ checkpointId, end: i ? 1000 : 2000, maxConversationId: 7, affected: { B: 1000, coverageAll: 2000 }, repairRequired: true }));
    } finally { independent.close(); }
    assert.deepEqual(call(), expected);
    assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
    const start = performance.now();
    if (scenario === 'ordinary') {
      // The ordinary path intentionally uses its shared connection, not the
      // deadline helper. Inject SQLITE_BUSY at that connection's driver edge.
      const stop = () => {
        waited = true;
        const timeout = shared.pragma('busy_timeout', { simple: true });
        events.push({ event: 'driver-wait', timeout, clock }); clock += timeout;
        throw busy();
      };
      shared.prepare = function(sql, ...args) {
        if (entry === 'transition' && sql.startsWith('SELECT * FROM mode_transitions WHERE')) stop();
        return originalPrepare.call(this, sql, ...args);
      };
      shared.exec = function(sql, ...args) {
        if (entry === 'audit' && sql === 'BEGIN') stop();
        return originalExec.call(this, sql, ...args);
      };
      assert.throws(() => call(), { code: 'DB_BUSY', persisted: [] });
      assert.equal(opened.length, 0, 'ordinary read must retain the shared path');
      assert.equal(clock, 105000);
    } else {
      const budget = { short: 1000, cap: 7000, released: 10000 }[scenario];
      if (scenario === 'released') assert.deepEqual(call(clock + budget), expected);
      else assert.throws(() => call(clock + budget), { code: scenario === 'short' ? 'deadline_exceeded' : 'DB_BUSY', persisted: [] });
      assert.equal(opened.length, 1);
      assert.ok(opened.every(db => !db.open), 'dedicated connection closes on both success and failure');
      assert.deepEqual(events[0].options, { readonly: true, fileMustExist: true, timeout: Math.min(5000, budget) });
      assert.equal(events.find(e => e.event === 'driver-wait').timeout, Math.min(5000, budget));
      assert.ok(timeouts.every(timeout => timeout > 0 && timeout <= Math.min(5000, budget)));
      assert.equal(clock, scenario === 'short' ? 101000 : scenario === 'cap' ? 105000 : 102000);
      if (scenario === 'released') assert.equal(timeouts.at(-1), 5000);
      if (scenario === 'cap') assert.ok(clock < 107000, 'ordinary cap expires with caller budget remaining');
    }
    assert.equal(waited, true, 'driver substitute must actually run');
    assert.equal(api.getDb(), shared);
    assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
    shared.prepare = originalPrepare; shared.exec = originalExec;
    assert.deepEqual(call(), expected, 'subsequent ordinary read recovers with unchanged rows');
    console.log(JSON.stringify({ selected: `${entry}:${scenario}`, controlledDriver: true, elapsed: performance.now() - start, clock, timeouts, events }));
  } finally {
    shared.prepare = originalPrepare; shared.exec = originalExec;
    api.close(); mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true });
  }
}
