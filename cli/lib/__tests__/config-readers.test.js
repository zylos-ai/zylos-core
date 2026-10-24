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
const caddySetup = path.join(rootDir, 'skills', 'http', 'scripts', 'setup-caddy.js');
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

  it('reads runtime strictly at the action boundary, leaving c4-config import available', () => {
    writeConfig(JSON.stringify({ runtime: 'codex', statusNotices: { brand: 'Product' } }));
    const valid = run(['--input-type=module', '-e', `const c=await import(${JSON.stringify(c4ConfigUrl)}); console.log(JSON.stringify(await c.getRuntimeIdentity()));`]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { runtime: 'codex', session: 'codex-main' });

    writeConfig('{');
    const imported = run(['--input-type=module', '-e', `await import(${JSON.stringify(c4ConfigUrl)});`]);
    assert.equal(imported.status, 0, imported.stderr);
    const malformed = run(['--input-type=module', '-e', `const c=await import(${JSON.stringify(c4ConfigUrl)}); await c.getRuntimeIdentity();`]);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /CONFIG_UNREADABLE|configuration is unreadable/);
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
    const enqueueFlag = path.join(root, 'enqueue-attempted.flag');
    const control = path.join(root, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
    fs.mkdirSync(path.dirname(control), { recursive: true });
    fs.writeFileSync(control, `require('node:fs').writeFileSync(${JSON.stringify(enqueueFlag)}, 'called');\n`);
    const invoked = spawnSync(process.execPath, [authHook], {
      env: { ...process.env, HOME: root, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: rootDir },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
      encoding: 'utf8',
    });
    assert.notEqual(invoked.status, 0);
    assert.match(invoked.stderr, /CONFIG_UNREADABLE/);
    assert.equal(fs.existsSync(enqueueFlag), false);
  });

  it('fails the standalone Caddy consumer before actions when F1 is malformed', () => {
    writeConfig('{');
    const caddy = path.join(root, 'bin', 'caddy');
    fs.mkdirSync(path.dirname(caddy), { recursive: true });
    fs.writeFileSync(caddy, '#!/bin/sh\nexit 99\n');
    fs.chmodSync(caddy, 0o755);
    const before = fs.readFileSync(path.join(root, '.zylos', 'config.json'), 'utf8');
    const result = run([caddySetup]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONFIG_UNREADABLE|configuration is unreadable/);
    assert.equal(fs.readFileSync(path.join(root, '.zylos', 'config.json'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(root, 'http', 'Caddyfile')), false);
  });

  it('keeps Docker environment priority and does not swallow strict fallback errors', () => {
    const source = fs.readFileSync(path.join(rootDir, 'docker', 'entrypoint.sh'), 'utf8');
    assert.match(source, /if \[ -z "\$\{ZYLOS_RUNTIME:-\}" \]/);
    assert.match(source, /readZylosConfigOrThrow/);
    assert.doesNotMatch(source, /catch \{ process\.stdout\.write\('claude'\)/);
  });
});
