import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCoreConfigModule } from '../core-config-loader.js';

test('Core discovery stops at each of its first three candidates without spawning npm', () => {
  for (const hit of ['explicit', 'source', 'path']) {
    const found = { explicit: '/package/cli/lib/config.js', source: '/source/cli/lib/config.js', path: '/installed/cli/lib/config.js' };
    let npmCalls = 0;
    let pathCalls = 0;
    const result = resolveCoreConfigModule({
      env: { ZYLOS_PACKAGE_ROOT: '/package', PATH: '/bin' }, here: '/source/skills/comm-bridge/scripts',
      exists: candidate => candidate === found[hit],
      access: candidate => { pathCalls++; assert.equal(candidate, '/bin/zylos'); },
      realpath: () => '/installed/cli/zylos.js',
      exec: () => { npmCalls++; throw new Error('npm must not run'); },
    });
    assert.equal(result, found[hit]);
    assert.equal(npmCalls, 0, hit);
    assert.equal(pathCalls, hit === 'path' ? 1 : 0);
  }
});

test('Core discovery uses npm only as the last fallback and fails explicitly if all candidates miss', () => {
  let calls = 0;
  const deps = { env: { PATH: '' }, here: '/missing/scripts', exists: () => false,
    exec: (command, args) => { calls++; assert.equal(command, 'npm'); assert.deepEqual(args, ['root', '-g']); return '/global\n'; } };
  assert.equal(resolveCoreConfigModule({ ...deps, exists: file => file === '/global/zylos/cli/lib/config.js' }), '/global/zylos/cli/lib/config.js');
  assert.equal(calls, 1);
  assert.throws(() => resolveCoreConfigModule(deps), /Cannot locate the installed zylos-core/);
  assert.equal(calls, 2);
});

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
