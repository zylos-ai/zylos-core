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

test('Antigravity installer timeout points to the instance proxy configuration', async t => {
  const { root } = fixture(t);
  const { install } = (await getRuntime('agy')).install;
  const exec = { execSync() { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); } };
  await assert.rejects(install({ root, exec }), {
    message: `Antigravity installation did not finish within 10 minutes. If this machine needs a proxy, set HTTPS_PROXY in ${path.join(root, '.env')} and retry.`,
  });
});

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

test('Antigravity installer and version check use the instance proxy and disable auto-update', async t => {
  const { root, executable } = fixture(t);
  const { install } = (await getRuntime('agy')).install;
  fs.writeFileSync(path.join(root, '.env'), 'HTTPS_PROXY=http://p\n');
  const exec = {
    execSync(command, { env, timeout, stdio }) {
      assert.equal(command, 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
      assert.equal(timeout, 600000);
      assert.equal(stdio, 'pipe');
      assert.equal(env.HTTPS_PROXY, 'http://p');
      assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    },
    execFileSync(command, args, { env }) {
      assert.equal(command, executable);
      assert.deepEqual(args, ['--version']);
      assert.equal(env.HTTPS_PROXY, 'http://p');
      assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    },
  };
  assert.equal(await install({ root, exec }), true);
});
