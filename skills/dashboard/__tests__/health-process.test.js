import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { bootId, publishHealthProcess } from '../src/lib/health-process.js';

test('health identity is private, atomic and bound to the current process', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'health-process.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    publishHealthProcess(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pid: process.pid, bootId });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root), ['health-process.json']);
  }
});

test('health boot identity changes in a new process', () => {
  const url = new URL('../src/lib/health-process.js', import.meta.url).href;
  const other = execFileSync(process.execPath, ['--input-type=module', '-e',
    'const {bootId}=await import(process.argv[1]);process.stdout.write(bootId)', url], { encoding: 'utf8' });
  assert.match(other, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(other, bootId);
});
