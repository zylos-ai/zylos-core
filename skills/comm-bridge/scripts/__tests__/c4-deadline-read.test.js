import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { withDeadlineRead } from '../c4-deadline-read.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-deadline-'));
  const filename = path.join(dir, 'fixture.db');
  const db = new Database(filename);
  guardDatabase(db, owner);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE deadline_fixture(value INTEGER); INSERT INTO deadline_fixture VALUES (1)');
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return filename;
}
function trackedOpen() {
  const opened = [];
  return { opened, open: (file, options) => { const db = new Database(file, options); opened.push(db); return db; } };
}
const read = db => db.prepare('SELECT value FROM deadline_fixture').pluck().get();
async function lock(t, filename, releaseAfter = 60000) {
  const source = `import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};
    const db = new Database(process.argv[1]);
    db.pragma('locking_mode=' + process.argv[2]);
    db.exec('BEGIN IMMEDIATE; UPDATE deadline_fixture SET value=2');
    process.send('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); process.exit(0); }, Number(process.argv[3]));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, filename, 'NORMAL', String(releaseAfter)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
  });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`lock process exited: ${stderr}`); })]);
  return child;
}
function timedCall(filename, duration, operation = read, extra = {}) {
  // Wall-clock deadline is injected; duration evidence uses a monotonic clock.
  const now = () => Date.now();
  const start = performance.now();
  let value, error;
  try { value = withDeadlineRead(filename, owner, now() + duration, operation, { now, ...extra }); }
  catch (caught) { error = caught; }
  return { value, error, elapsed: performance.now() - start };
}

test('record actual runtime and embedded SQLite versions', t => {
  const db = new Database(':memory:');
  t.diagnostic(JSON.stringify({ node: process.version, betterSqlite3: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.resolve('better-sqlite3')), 'utf8')).version, sqlite: db.prepare('SELECT sqlite_version()').pluck().get() }));
  db.close();
});

test('expired deadline does not open; invalid deadline is rejected', () => {
  let opens = 0;
  for (const deadline of [99, 100]) assert.throws(() => withDeadlineRead('unused', owner, deadline, read, { now: () => 100, open: () => { opens++; } }), { code: 'deadline_exceeded', persisted: [] });
  for (const deadline of [NaN, Infinity, '100']) assert.throws(() => withDeadlineRead('unused', owner, deadline, read), { code: 'INVALID_ARGS' });
  assert.equal(opens, 0);
});

test('readonly connection closes on success and query failure; shared connection is unchanged', t => {
  const filename = fixture(t), tracker = trackedOpen();
  const shared = new Database(filename, { timeout: 5000 });
  t.after(() => shared.close());
  assert.equal(withDeadlineRead(filename, owner, Date.now() + 1000, db => { assert.equal(db.readonly, true); return read(db); }, tracker), 1);
  assert.throws(() => withDeadlineRead(filename, owner, Date.now() + 1000, db => db.exec('UPDATE deadline_fixture SET value=9'), tracker), { code: 'SQLITE_READONLY' });
  assert.equal(read(shared), 1);
  assert.equal(shared.pragma('busy_timeout', { simple: true }), 5000);
  assert.ok(tracker.opened.every(db => !db.open));
});

test('read owner check rejects old, future and malformed layouts without migration', t => {
  for (const kind of ['old', 'future', 'malformed']) {
    const filename = fixture(t), db = new Database(filename), tracker = trackedOpen();
    if (kind === 'old') db.pragma('user_version=1');
    if (kind === 'future') db.pragma('user_version=999');
    if (kind === 'malformed') db.exec('DROP TABLE group_heads');
    db.close();
    const before = fs.readFileSync(filename);
    assert.throws(() => withDeadlineRead(filename, owner, Date.now() + 1000, read, tracker));
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.ok(tracker.opened.every(db => !db.open));
  }
});

test('missing file does not create database or parent directory', t => {
  const filename = path.join(path.dirname(fixture(t)), 'absent', 'missing.db');
  assert.throws(() => withDeadlineRead(filename, owner, Date.now() + 1000, read));
  assert.equal(fs.existsSync(path.dirname(filename)), false);
});

test('owner inspection and operation share remaining budget and close on expiration', t => {
  const filename = fixture(t), tracker = trackedOpen();
  let now = 100, called = false;
  const slowOwner = { ...owner, inspectSchema(db, options) { const layout = owner.inspectSchema(db, options); now = 201; return layout; } };
  assert.throws(() => withDeadlineRead(filename, slowOwner, 200, () => { called = true; }, { now: () => now, ...tracker }), { code: 'deadline_exceeded' });
  assert.equal(called, false);
  assert.ok(tracker.opened.every(db => !db.open));
});

test('ordinary WAL writer qualifies as nonblocking and returns committed snapshot', async t => {
  const filename = fixture(t); await lock(t, filename);
  const result = timedCall(filename, 1000);
  t.diagnostic(`ordinary WAL writer: ${result.elapsed.toFixed(1)}ms`);
  assert.equal(result.error, undefined); assert.equal(result.value, 1); assert.ok(result.elapsed < 900);
});

test('already started readonly query completes after deadline', t => {
  const filename = fixture(t);
  const result = timedCall(filename, 1000, db => {
    db.function('slow_value', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); return 42; });
    return db.prepare('SELECT slow_value()').pluck().get();
  });
  assert.equal(result.error, undefined); assert.equal(result.value, 42); assert.ok(result.elapsed >= 2000);
});

test('constructor failure propagates without closing an unavailable connection', () => {
  const failure = new Error('open failed');
  assert.throws(() => withDeadlineRead('unused', owner, 200, read, { now: () => 100, open() { throw failure; } }), error => error === failure);
});

test('owner failure closes connection and preserves non-busy error', t => {
  const filename = fixture(t), tracker = trackedOpen(), failure = new Error('schema inspection failed');
  assert.throws(() => withDeadlineRead(filename, { inspectSchema() { throw failure; } }, Date.now() + 1000, read, tracker), error => error === failure);
  assert.equal(tracker.opened.length, 1); assert.equal(tracker.opened[0].open, false);
});

test('busy errors are classified using wait budget source, not just the deadline clock', () => {
  for (const { remaining, finish, code } of [
    { remaining: 1000, finish: 500, code: 'DB_BUSY' },
    { remaining: 1000, finish: 1000, code: 'deadline_exceeded' },
    { remaining: 7000, finish: 8000, code: 'DB_BUSY' },
  ]) {
    let now = 0, closed = false;
    const connection = { pragma() {}, close() { closed = true; } };
    assert.throws(() => withDeadlineRead('unused', { SUPPORTED_SCHEMA_VERSION: 2, inspectSchema: () => ({ version: 2 }) }, remaining, () => {
      now = finish; throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    }, { now: () => now, open: () => connection }), { code, persisted: [] });
    assert.equal(closed, true);
  }
});
