import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-transactions-'));
  const filename = path.join(dir, 'test.db');
  const db = new Database(filename, { timeout: 20 });
  guardDatabase(db, owner);
  db.pragma('journal_mode=WAL');
  db.pragma('busy_timeout=20');
  const observer = new Database(filename, { readonly: true, timeout: 20 });
  t.after(() => { if (observer.open) observer.close(); if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, observer, filename };
}
function intercept(db, exec) {
  return new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => exec(sql, () => target.exec(sql));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const store = db => createStore(db, { validateComponent: () => true, validateModel: () => true });
// Oracle reads committed rows using another connection; no production getters.
function ledger(db) {
  return Object.fromEntries(['channel_namespaces', 'conversations', 'group_heads', 'group_runtime_overrides'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('non-SQLite I/O error maps to DB_WRITE_FAILED only after confirmed rollback', t => {
  const { db, observer } = fixture(t), before = ledger(observer), events = [];
  const failure = Object.assign(new Error('simulated I/O fault'), { code: 'EIO' });
  const s = store(intercept(db, (sql, perform) => { events.push(sql); if (sql === 'COMMIT') throw failure; return perform(); }));
  assert.throws(() => s.insertConversation('in', 'foo', 'endpoint', 'message'), error => {
    assert.equal(error.code, 'DB_WRITE_FAILED'); assert.equal(error.cause, failure); assert.deepEqual(error.persisted, []); return true;
  });
  assert.deepEqual(events, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
  assert.equal(db.inTransaction, false); assert.deepEqual(ledger(observer), before);
});

for (const kind of ['message', 'config', 'handler', 'snapshot']) {
  test(`rollback failure exits process before reporting or serving another request: ${kind}`, t => {
    const { observer, filename } = fixture(t), before = ledger(observer);
    const source = `import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};
      import { createStore } from ${JSON.stringify(new URL('../c4-v2-store.js', import.meta.url).href)};
      import { createConfigHandler } from ${JSON.stringify(new URL('../c4-config-handler.js', import.meta.url).href)};
      const db = new Database(process.argv[1]);
      const nativeExec = db.exec.bind(db);
      db.exec = sql => {
        if (sql === 'COMMIT') throw Object.assign(new Error('commit failed'), { code: 'EIO' });
        if (sql === 'ROLLBACK') throw Object.assign(new Error('rollback unavailable'), { code: 'ROLLBACK_IO' });
        return nativeExec(sql);
      };
      let opens = 0;
      const s = createStore(() => { opens++; if (opens > 1) process.stdout.write('REOPENED\\n'); return db; }, { validateComponent: () => true, readConfig: () => ({state:'missing'}) });
      const handler = createConfigHandler({ store: s, readSessionMode: () => 'multi', observeRunning: () => ({hasProcess:false}) });
      try {
        if (process.argv[2] === 'message') s.insertConversation('in','foo','endpoint','message');
        else if (process.argv[2] === 'config') s.setSessionRuntimeConfig({ sessionGroup:'origin',runtime:'codex' });
        else if (process.argv[2] === 'handler') await handler('runtime',{action:'set',sessionGroup:'origin',runtime:'codex'});
        else s.getUnsummarizedRange('origin');
        process.stdout.write('REPORTED_SUCCESS\\n');
      } catch (error) { process.stdout.write('REPORTED_ERROR '+JSON.stringify({code:error.code,persisted:error.persisted})+'\\n'); }
      s.getChannelNamespace('foo');
      s.ensureChannelNamespace('bar');
      process.stdout.write('SERVED_NEXT_REQUEST\\n');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, filename, kind], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0); assert.notEqual(result.status, null);
    assert.equal(result.stdout, '', 'no result, same-process reopen, or subsequent read/write is allowed');
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 1, result.stderr);
    assert.deepEqual(JSON.parse(lines[0]), { code: 'EIO', rollbackError: { code: 'ROLLBACK_IO', message: 'rollback unavailable' } });
    // Reopening happens only in the parent after the crashed worker has exited.
    const recovered = new Database(filename, { readonly: true, fileMustExist: true });
    try { assert.deepEqual(ledger(recovered), before); } finally { recovered.close(); }
    t.diagnostic(JSON.stringify({ kind, exit: result.status, stderr: lines[0], recovered: true }));
  });
}

test('two real connections contend for writer lock: DB_BUSY with empty persistence', t => {
  const { db, observer, filename } = fixture(t), writer = new Database(filename, { timeout: 20 });
  t.after(() => writer.close());
  const before = ledger(observer);
  writer.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => store(db).ensureChannelNamespace('foo'), { code: 'DB_BUSY', persisted: [] });
    assert.equal(db.inTransaction, false); assert.deepEqual(ledger(observer), before);
  } finally { writer.exec('ROLLBACK'); }
});

for (const kind of ['message', 'internal']) {
  test(`${kind} trigger failure is atomic; independent ledger detects transaction-removal mutant`, t => {
    for (const mutant of [false, true]) {
      const { db, observer } = fixture(t), normal = store(db);
      if (kind === 'internal') {
        normal.insertConversation('in', 'foo', 'endpoint-a', 'seed-a');
        normal.insertConversation('in', 'bar', 'endpoint-b', 'seed-b');
        db.exec("CREATE TRIGGER fail_internal BEFORE INSERT ON conversations WHEN NEW.channel='internal' AND NEW.direction='in' BEGIN SELECT RAISE(ABORT,'fail second internal row'); END");
      } else {
        db.exec("CREATE TRIGGER fail_head BEFORE INSERT ON group_heads BEGIN SELECT RAISE(ABORT,'fail head after message'); END");
      }
      const before = ledger(observer);
      // Known-bad local mutation bypasses transaction boundaries, not the oracle.
      const target = mutant ? intercept(db, (sql, perform) => ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'].includes(sql) ? db : perform()) : db;
      const s = store(target);
      assert.throws(() => kind === 'internal' ? s.insertInternalMessage('foo', 'bar', 'hello') : s.insertConversation('in', 'new', 'endpoint', 'hello'), { code: 'DB_WRITE_FAILED' });
      const after = ledger(observer);
      if (mutant) {
        assert.throws(() => assert.deepEqual(after, before), assert.AssertionError);
        assert.equal(after.conversations.length, before.conversations.length + 1);
        if (kind === 'message') assert.equal(after.channel_namespaces.length, 1);
      } else {
        assert.deepEqual(after, before); assert.equal(db.inTransaction, false);
      }
    }
  });
}
