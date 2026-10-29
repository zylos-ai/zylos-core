import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/lib/store.js';

const CLI = path.resolve('scripts/api-key.js');

function makeTmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-key-cli-test-'));
  const dbPath = path.join(dir, 'dashboard.db');
  const store = new Store(dbPath);
  store.db.close();
  return { dir, dbPath };
}

function run(dbPath, ...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ZYLOS_DATA_DIR: path.dirname(dbPath) },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function runFail(dbPath, ...args) {
  try {
    execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ZYLOS_DATA_DIR: path.dirname(dbPath) },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.fail('Expected command to fail');
  } catch (err) {
    assert.notEqual(err.status, 0);
    return err.stderr;
  }
}

test('generate creates a key and list shows it', () => {
  const { dbPath } = makeTmpDb();
  const out = run(dbPath, 'generate', 'test-key', 'read');
  assert.match(out, /API key created: test-key/);
  assert.match(out, /Key: zylos_ak_/);
  const list = run(dbPath, 'list');
  assert.match(list, /test-key/);
  assert.match(list, /scope=read/);
  assert.match(list, /status=active/);
});

test('generate with admin scope', () => {
  const { dbPath } = makeTmpDb();
  const out = run(dbPath, 'generate', 'admin-key', 'admin');
  assert.match(out, /scope: admin/);
  const list = run(dbPath, 'list');
  assert.match(list, /scope=admin/);
});

test('generate duplicate active name fails', () => {
  const { dbPath } = makeTmpDb();
  run(dbPath, 'generate', 'dup-key', 'read');
  const err = runFail(dbPath, 'generate', 'dup-key', 'read');
  assert.match(err, /already exists/);
});

test('generate reuses name after revoke', () => {
  const { dbPath } = makeTmpDb();
  run(dbPath, 'generate', 'reuse-key', 'read');
  run(dbPath, 'revoke', 'reuse-key');
  const out = run(dbPath, 'generate', 'reuse-key', 'admin');
  assert.match(out, /API key created: reuse-key/);
  assert.match(out, /scope: admin/);
});

test('rotate issues new key and invalidates old', () => {
  const { dbPath } = makeTmpDb();
  const gen = run(dbPath, 'generate', 'rot-key', 'read');
  const oldKey = gen.match(/Key: (zylos_ak_\w+)/)[1];

  const rot = run(dbPath, 'rotate', 'rot-key');
  assert.match(rot, /API key rotated: rot-key/);
  assert.match(rot, /New key: zylos_ak_/);
  const newKey = rot.match(/New key: (zylos_ak_\w+)/)[1];
  assert.notEqual(oldKey, newKey);
  assert.match(rot, /sessions have been invalidated/);
});

test('rotate nonexistent key fails', () => {
  const { dbPath } = makeTmpDb();
  const err = runFail(dbPath, 'rotate', 'ghost');
  assert.match(err, /No active API key found/);
});

test('revoke marks key as revoked', () => {
  const { dbPath } = makeTmpDb();
  run(dbPath, 'generate', 'rev-key', 'read');
  const out = run(dbPath, 'revoke', 'rev-key');
  assert.match(out, /API key revoked: rev-key/);
  const list = run(dbPath, 'list');
  assert.match(list, /status=revoked/);
});

test('revoke nonexistent key fails', () => {
  const { dbPath } = makeTmpDb();
  const err = runFail(dbPath, 'revoke', 'ghost');
  assert.match(err, /No active API key found/);
});

test('delete removes revoked keys', () => {
  const { dbPath } = makeTmpDb();
  run(dbPath, 'generate', 'del-key', 'read');
  run(dbPath, 'revoke', 'del-key');
  const out = run(dbPath, 'delete', 'del-key');
  assert.match(out, /Deleted 1 revoked key/);
  const list = run(dbPath, 'list');
  assert.doesNotMatch(list, /del-key/);
});

test('delete active key fails with guidance', () => {
  const { dbPath } = makeTmpDb();
  run(dbPath, 'generate', 'active-key', 'read');
  const err = runFail(dbPath, 'delete', 'active-key');
  assert.match(err, /still active.*Revoke it first/);
});

test('delete nonexistent key fails', () => {
  const { dbPath } = makeTmpDb();
  const err = runFail(dbPath, 'delete', 'ghost');
  assert.match(err, /No revoked API key found/);
});

test('purge-revoked removes all revoked keys', () => {
  const { dbPath } = makeTmpDb();
  run(dbPath, 'generate', 'p1', 'read');
  run(dbPath, 'generate', 'p2', 'read');
  run(dbPath, 'generate', 'p3', 'read');
  run(dbPath, 'revoke', 'p1');
  run(dbPath, 'revoke', 'p2');
  const out = run(dbPath, 'purge-revoked');
  assert.match(out, /Purged 2 revoked key/);
  const list = run(dbPath, 'list');
  assert.match(list, /p3/);
  assert.doesNotMatch(list, /\bp1\b/);
  assert.doesNotMatch(list, /\bp2\b/);
});

test('purge-revoked with nothing to purge', () => {
  const { dbPath } = makeTmpDb();
  const out = run(dbPath, 'purge-revoked');
  assert.match(out, /No revoked keys to purge/);
});

test('no command shows usage with all commands', () => {
  const { dbPath } = makeTmpDb();
  const out = run(dbPath);
  assert.match(out, /Usage:/);
  assert.match(out, /rotate/);
  assert.match(out, /delete/);
  assert.match(out, /purge-revoked/);
});

test('no command shows usage even without a database', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-key-nodb-'));
  const out = run(path.join(emptyDir, 'dashboard.db'));
  assert.match(out, /Usage:/);
  assert.match(out, /rotate/);
});

test('missing arg shows command usage without requiring database', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-key-nodb-'));
  const err = runFail(path.join(emptyDir, 'dashboard.db'), 'generate');
  assert.match(err, /Usage: api-key\.js generate/);
});
