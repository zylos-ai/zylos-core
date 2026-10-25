import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(import.meta.dirname, '../../..');
const cliPath = path.join(rootDir, 'cli', 'zylos.js');
const c4ConfigUrl = pathToFileURL(path.join(rootDir, 'skills', 'comm-bridge', 'scripts', 'c4-config.js')).href;
const loaderUrl = pathToFileURL(path.join(rootDir, 'skills', 'comm-bridge', 'scripts', 'core-config-loader.js')).href;
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-config-readers-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, args, {
    env: { ...process.env, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: rootDir, ...extraEnv },
    encoding: 'utf8',
  });
}

function writeConfig(source) {
  const file = path.join(root, '.zylos', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

describe('strict runtime readers', () => {
  it('shares CONFIG_UNREADABLE with the original cause and only defaults missing F1', () => {
    const configUrl = pathToFileURL(path.join(rootDir, 'cli/lib/config.js')).href;
    const read = `const {readZylosConfigOrThrow:read}=await import(${JSON.stringify(configUrl)});`;
    for (const source of [null, '{}', '{"runtime":"codex"}']) {
      if (source !== null) writeConfig(source);
      const result = run(['--input-type=module', '-e', `${read} console.log(JSON.stringify(read()));`]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), source ? JSON.parse(source) : {});
    }
    writeConfig('{ broken');
    const malformed = run(['--input-type=module', '-e', `${read} try {read();process.exit(9)} catch(error){console.log(JSON.stringify({code:error.code,cause:error.cause?.name}));}`]);
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.deepEqual(JSON.parse(malformed.stdout), { code: 'CONFIG_UNREADABLE', cause: 'SyntaxError' });
  });

  it('defaults a missing runtime but rejects malformed F1 at the CLI boundary', () => {
    const missing = run([cliPath, 'runtime', 'status']);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /Claude Code/);
    writeConfig('{');
    const malformed = run([cliPath, 'runtime', 'status']);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /configuration is unreadable/i);
  });

  it('applies the missing-key runtime and statusNotices matrix from one snapshot', () => {
    const cases = [
      { config: null, expected: { runtime: 'claude', notices: {} } },
      { config: {}, expected: { runtime: 'claude', notices: {} } },
      { config: { runtime: 'other', statusNotices: null }, expected: { runtime: 'claude', notices: {} } },
      { config: { runtime: 'codex' }, expected: { runtime: 'codex', notices: {} } },
      { config: { statusNotices: { prefix: 'Core' } }, expected: { runtime: 'claude', notices: { prefix: 'Core' } } },
    ];
    for (const [index, entry] of cases.entries()) {
      const file = path.join(root, '.zylos', 'config.json');
      fs.rmSync(file, { force: true });
      if (entry.config !== null) writeConfig(JSON.stringify(entry.config));
      const result = run(['--input-type=module', '-e', `const c=await import(${JSON.stringify(`${c4ConfigUrl}?matrix=${index}`)}); const core=await import(${JSON.stringify(loaderUrl)}); const config=(await core.loadCoreConfig()).readZylosConfigOrThrow(); console.log(JSON.stringify({runtime:(await c.getRuntimeIdentity()).runtime,notices:config.statusNotices??{}}));`]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), entry.expected);
    }
  });

});
