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
