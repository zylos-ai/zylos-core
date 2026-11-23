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
