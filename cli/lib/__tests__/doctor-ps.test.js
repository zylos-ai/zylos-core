import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPs } from '../../commands/doctor.js';

test('doctor ps probe detects a missing command in a private PATH', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-ps-'));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; fs.rmSync(dir, { recursive: true, force: true }); });
  process.env.PATH = dir;
  assert.deepEqual(checkPs(), { available: false, reason: 'not_found' });
});

test('doctor ps probe accepts the installed command', () => {
  assert.deepEqual(checkPs(), { available: true });
});

test('doctor ps probe reports command failures as unavailable', () => {
  for (const [error, reason] of [
    [{ code: 'EACCES' }, 'EACCES'],
    [{ code: 'ETIMEDOUT' }, 'ETIMEDOUT'],
    [{ status: 1 }, 'exit_1'],
  ]) {
    assert.deepEqual(checkPs({ execute: () => { throw Object.assign(new Error(), error); } }),
      { available: false, reason });
  }
});
