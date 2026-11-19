import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntime } from '../index.js';

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
