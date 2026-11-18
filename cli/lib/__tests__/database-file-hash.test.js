import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {hash as workerHash, HASH_CHUNK_BYTES as WORKER_CHUNK} from '../core-db-backup-worker.js';

const require = createRequire(import.meta.url);
const maintenance = require('../upgrade-maintenance.cjs');
let Database;
try { Database = createRequire(path.resolve('skills/comm-bridge/package.json'))('better-sqlite3'); } catch {}

const implementations = [['snapshot worker', workerHash], ['upgrade maintenance', maintenance.hash]];
const wholeFileDigest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-file-hash-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('chunked hash equals a whole-file sha256 at every chunk boundary', t => {
  const dir = tempDir(t);
  const sizes = [0, 1, WORKER_CHUNK - 1, WORKER_CHUNK, WORKER_CHUNK + 1, 2 * WORKER_CHUNK, 3 * WORKER_CHUNK + 7];
  for (const size of sizes) {
    const file = path.join(dir, `bytes-${size}`);
    fs.writeFileSync(file, crypto.randomBytes(size));
    const expected = wholeFileDigest(file);
    for (const [name, hash] of implementations) assert.equal(hash(file), expected, `${name}, ${size} bytes`);
  }
});

test('chunked hash equals a whole-file sha256 for a multi-megabyte SQLite database', {skip: !Database}, t => {
  const file = path.join(tempDir(t), 'dashboard.db');
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)');
    const insert = db.prepare('INSERT INTO blobs (data) VALUES (?)');
    for (let i = 0; i < 40; i++) insert.run(crypto.randomBytes(100 * 1024));
  } finally { db.close(); }
  assert.ok(fs.statSync(file).size > 3 * WORKER_CHUNK);
  const expected = wholeFileDigest(file);
  for (const [name, hash] of implementations) assert.equal(hash(file), expected, name);
});

test('hashing never reads more than one chunk at a time', t => {
  const file = path.join(tempDir(t), 'large');
  fs.writeFileSync(file, crypto.randomBytes(4 * WORKER_CHUNK + 3));
  const expected = wholeFileDigest(file);
  // A whole-file read fails above 2 GiB and holds the full database in memory.
  t.mock.method(fs, 'readFileSync', () => { throw Error('whole-file read'); });
  const readSync = fs.readSync;
  let largest = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    largest = Math.max(largest, length);
    return readSync(fd, buffer, offset, length, position);
  });
  for (const [name, hash] of implementations) assert.equal(hash(file), expected, name);
  assert.ok(largest > 0 && largest <= WORKER_CHUNK, `largest read ${largest}`);
});

test('chunked hash reports a missing file like a whole-file read', t => {
  const file = path.join(tempDir(t), 'missing.db');
  for (const [, hash] of implementations) assert.throws(() => hash(file), {code: 'ENOENT'});
});
