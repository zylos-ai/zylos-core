import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getRuntime } from '../index.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'agy');
  fs.writeFileSync(executable, '', { mode: 0o700 });
  const previous = process.env.AGY_BIN;
  process.env.AGY_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = previous;
  });
  return { root, executable };
}

test('Antigravity installer verifies the executable even when the script succeeds', async t => {
  const { root, executable } = fixture(t);
  const { install } = (await getRuntime('agy')).install;
  const calls = [];
  const exec = {
    execSync() {},
    execFileSync(command, args, { timeout }) {
      calls.push({ command, args, timeout });
      throw new Error('version failed');
    },
  };
  assert.equal(await install({ root, exec }), false);
  assert.deepEqual(calls, [{ command: executable, args: ['--version'], timeout: 10000 }]);
});
