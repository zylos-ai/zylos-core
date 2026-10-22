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
const authHook = path.join(rootDir, 'skills', 'activity-monitor', 'scripts', 'hook-auth-prompt.js');
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
  it('defaults a missing runtime but rejects malformed F1 at the CLI boundary', () => {
    const missing = run([cliPath, 'runtime', 'status']);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /Claude Code/);
    writeConfig('{');
    const malformed = run([cliPath, 'runtime', 'status']);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /configuration is unreadable/i);
  });

  it('loads runtime and statusNotices from the same strict c4-config snapshot', () => {
    writeConfig(JSON.stringify({ runtime: 'codex', statusNotices: { brand: 'Product' } }));
    const valid = run(['--input-type=module', '-e', `const c=await import(${JSON.stringify(c4ConfigUrl)}); console.log(JSON.stringify({runtime:c.ACTIVE_RUNTIME,notices:c.STATUS_NOTICE_CONFIG}));`]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { runtime: 'codex', notices: { brand: 'Product' } });

    writeConfig('{');
    const malformed = run(['--input-type=module', '-e', `await import(${JSON.stringify(c4ConfigUrl)});`]);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /CONFIG_UNREADABLE|configuration is unreadable/);
  });

  it('fails explicitly when an installed Core module cannot be located', () => {
    const missingRoot = path.join(root, 'missing-package');
    const result = run(['--input-type=module', '-e', `const l=await import(${JSON.stringify(loaderUrl)}); await l.loadCoreConfig();`], {
      ZYLOS_PACKAGE_ROOT: missingRoot,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot locate the installed zylos-core/);
  });

  it('does not auto-approve when the auth hook sees malformed F1', () => {
    writeConfig('{');
    const invoked = spawnSync(process.execPath, [authHook], {
      env: { ...process.env, HOME: root, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: rootDir },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
      encoding: 'utf8',
    });
    assert.notEqual(invoked.status, 0);
    assert.match(invoked.stderr, /CONFIG_UNREADABLE/);
    assert.equal(fs.existsSync(path.join(root, 'activity-monitor', 'enqueue-attempted.flag')), false);
  });

  it('keeps Docker environment priority and does not swallow strict fallback errors', () => {
    const source = fs.readFileSync(path.join(rootDir, 'docker', 'entrypoint.sh'), 'utf8');
    assert.match(source, /if \[ -z "\$\{ZYLOS_RUNTIME:-\}" \]/);
    assert.match(source, /readZylosConfigStrict/);
    assert.doesNotMatch(source, /catch \{ process\.stdout\.write\('claude'\)/);
  });
});
