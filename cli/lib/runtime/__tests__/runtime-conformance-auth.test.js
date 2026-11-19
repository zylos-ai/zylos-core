import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UNSUPPORTED } from '../contract.js';
import { getRuntime, SUPPORTED_RUNTIMES } from '../index.js';

for (const id of ['claude', 'codex']) {
  test(`${id} classifies CLI login statuses from recorded samples`, async t => {
    const samples = new URL(`./samples/${id}/auth/`, import.meta.url);
    const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', samples), 'utf8'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-auth-sample-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { HOME: root, CODEX_HOME: path.join(root, '.codex') };
    const { auth } = await getRuntime(id);
    for (const status of ['success', 'failure']) {
      const filename = `${status}.json`;
      assert.ok(Object.hasOwn(manifest.files, filename), `manifest must describe ${filename}`);
      const output = JSON.parse(await fs.readFile(new URL(filename, samples), 'utf8'));
      const { exitCode, stdout, stderr } = output;
      assert.ok(Number.isInteger(exitCode));
      assert.equal(typeof stdout, 'string');
      assert.equal(typeof stderr, 'string');
      const execFile = async () => {
        if (exitCode !== 0) throw Object.assign(new Error('CLI exited unsuccessfully'), { code: exitCode, stdout, stderr });
        return { stdout, stderr };
      };
      assert.equal((await auth.checkAuth({ root, env, execFile })).status, status, filename);
    }
  });
}

test('authentication metadata and optional capabilities agree', async () => {
  for (const id of SUPPORTED_RUNTIMES) {
    const { auth } = await getRuntime(id);
    assert.equal(typeof auth.remedy, 'string', id);
    assert.ok(auth.remedy.trim(), id);
    const files = auth.credentialFiles();
    assert.ok(Array.isArray(files) && files.every(file => path.isAbsolute(file)), id);
    assert.equal(auth.credentialKinds === UNSUPPORTED, auth.saveCredential === UNSUPPORTED, id);
    assert.equal(auth.baseUrlExample === UNSUPPORTED, auth.saveBaseUrl === UNSUPPORTED, id);
    if (auth.nativeLogin !== UNSUPPORTED) {
      assert.ok(Array.isArray(auth.nativeLogin.args), id);
      assert.ok(auth.nativeLogin.deviceArgs === null || Array.isArray(auth.nativeLogin.deviceArgs), id);
    }
  }
});
