import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('Core loader rejects an existing module without the required real exports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-loader-'));
  try {
    fs.mkdirSync(path.join(root, 'cli/lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(root, 'cli/lib/config.js'), 'export const readZylosConfigStrict = () => ({});');
    const loader = new URL('../core-config-loader.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await (await import(${JSON.stringify(loader)})).loadCoreConfig()`], {
      env: { ...process.env, ZYLOS_PACKAGE_ROOT: root }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing readZylosConfigOrThrow/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Core loader retries after rejection and shares concurrent successful loads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-loader-retry-'));
  try {
    const loader = new URL('../core-config-loader.js', import.meta.url).href;
    const packageRoot = path.resolve(import.meta.dirname, '../../../..');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { loadCoreConfig } = await import(${JSON.stringify(loader)});
      await assert.rejects(loadCoreConfig(), /Cannot locate/);
      process.env.ZYLOS_PACKAGE_ROOT = ${JSON.stringify(packageRoot)};
      const modules = await Promise.all(Array.from({ length: 5 }, () => loadCoreConfig()));
      assert.equal(typeof modules[0].readZylosConfigOrThrow, 'function');
      for (const module of modules) assert.equal(module, modules[0]);
      process.env.ZYLOS_PACKAGE_ROOT = ${JSON.stringify(root)};
      assert.equal(await loadCoreConfig(), modules[0]);
    `], {
      env: { ...process.env, HOME: root, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: root },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
