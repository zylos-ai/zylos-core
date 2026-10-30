import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-base-url-'));
const originalEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, CODEX_BIN: process.env.CODEX_BIN };
after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
process.env.HOME = tmpRoot;
process.env.ZYLOS_DIR = path.join(tmpRoot, 'zylos-home');
fs.mkdirSync(process.env.ZYLOS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.ZYLOS_DIR, '.env'), '', 'utf8');

describe('runtime base URL support', () => {
  test('Codex readiness returns objects for missing instructions and valid or invalid real trust', async t => {
    const { runtimeHooksReady } = await import('../../commands/runtime.js');
    const { installCoreCodexHook, codexHooksPath, codexTrustMarkerPath, hookKeyFor,
      isCodexTrustValid } = await import('../codex-hooks.js');
    const { stringify } = await import('smol-toml');
    const root = process.env.ZYLOS_DIR;
    const instruction = path.join(root, 'AGENTS.md');
    const fakeCodex = path.join(tmpRoot, 'codex-version');
    const version = 'codex-cli 0.142.2';
    const oldBin = process.env.CODEX_BIN;
    process.env.CODEX_BIN = fakeCodex;
    t.after(() => { if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin; });
    fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
    const hooksPath = codexHooksPath(root);
    installCoreCodexHook({ zylosDir: root });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '[features]\nhooks = true\n');
    const key = hookKeyFor({ zylosDir: root, event: 'SessionStart', groupIndex: 0, hookIndex: 0 });
    const trustSnapshot = { [key]: { enabled: true, trusted_hash: 'fixture-current-hash' } };
    fs.mkdirSync(path.join(tmpRoot, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.codex', 'config.toml'), stringify({ features: { hooks: true }, hooks: { state: trustSnapshot } }));
    const marker = { hooksHash: crypto.createHash('sha256').update(fs.readFileSync(hooksPath)).digest('hex'),
      codexVersion: version, trustSnapshot };
    fs.writeFileSync(codexTrustMarkerPath(root), JSON.stringify(marker));
    assert.deepEqual(isCodexTrustValid({ zylosDir: root, homeDir: tmpRoot, codexVersion: version }), { valid: true, reason: 'trusted' });
    assert.deepEqual(await runtimeHooksReady('codex'), { ready: false, pendingMigration: true });
    fs.writeFileSync(instruction, '# Fixture instructions\n');
    assert.deepEqual(await runtimeHooksReady('codex'), { ready: true, pendingMigration: true });
    fs.writeFileSync(codexTrustMarkerPath(root), JSON.stringify({ ...marker, hooksHash: 'stale' }));
    assert.deepEqual(await runtimeHooksReady('codex'), { ready: false, pendingMigration: true });
    fs.rmSync(instruction);
  });
  test('readiness checks installed project hooks, and rejects missing/stale hooks', async t => {
    const { runtimeHooksReady, executeRuntimeSwitch } = await import('../../commands/runtime.js');
    const { syncRuntimeHooks } = await import('../sync-runtime-hooks.js');
    const instruction = path.join(process.env.ZYLOS_DIR, 'CLAUDE.md');
    const installed = path.join(process.env.ZYLOS_DIR, '.claude', 'settings.json');
    assert.deepEqual(await runtimeHooksReady('claude'), { ready: false, pendingMigration: true });
    fs.writeFileSync(instruction, 'legacy instructions\n');
    syncRuntimeHooks({ zylosDir: process.env.ZYLOS_DIR });
    const good = fs.readFileSync(installed);
    const userSettings = path.join(tmpRoot, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(userSettings, '{broken');
    assert.deepEqual(await runtimeHooksReady('claude'), { ready: true, pendingMigration: true });
    let writes = 0;
    const deps = { read: () => ({ state: 'ok', config: { runtime: 'codex', session_mode: 'multi' } }),
      exists: () => true, adapter: () => ({ checkAuth: () => assert.fail('no-validate must skip auth') }),
      write: () => { writes++; return { previous: { runtime: 'codex' }, config: { runtime: 'claude', session_mode: 'multi' }, changed: true }; },
      observe: async () => ({ groups: [], groupsComplete: true, observationErrors: [] }) };
    assert.equal((await executeRuntimeSwitch('claude', ['--no-validate'], deps)).ok, true);
    for (const bad of [null, '{}', '{broken']) {
      if (bad === null) fs.rmSync(installed); else fs.writeFileSync(installed, bad);
      const result = await executeRuntimeSwitch('claude', ['--no-validate'], deps);
      assert.deepEqual(await runtimeHooksReady('claude'), { ready: false, pendingMigration: true });
      assert.equal(result.error.code, 'HOOKS_NOT_READY');
      assert.deepEqual(result.error.persisted, []);
    }
    assert.equal(writes, 1);
    fs.writeFileSync(installed, good);
    t.after(() => { fs.rmSync(userSettings, { force: true }); });
  });


  test('runtime command exports helpers for base-url parsing and validation', async () => {
    const runtimeModule = await import('../../commands/runtime.js');

    assert.equal(typeof runtimeModule.parseRuntimeFlags, 'function');
    assert.equal(typeof runtimeModule.validateRuntimeFlags, 'function');
    assert.equal(typeof runtimeModule.showHelp, 'function');
  });

  test('parseRuntimeFlags accepts --save-base-url and --no-validate, and showHelp shows both', async () => {
    const runtimeModule = await import('../../commands/runtime.js');
    const flags = runtimeModule.parseRuntimeFlags([
      '--save-apikey', 'sk-test',
      '--save-base-url', 'https://proxy.example.com/v1',
      '--no-validate',
    ]);

    assert.equal(flags.apiKey, 'sk-test');
    assert.equal(flags.baseUrl, 'https://proxy.example.com/v1');
    assert.equal(flags.noValidate, true);

    const originalLog = console.log;
    let output = '';
    console.log = (line = '') => {
      output += `${line}\n`;
    };

    try {
      runtimeModule.showHelp();
    } finally {
      console.log = originalLog;
    }

    assert.match(output, /--save-base-url <url>/);
    assert.match(output, /--no-validate/);
  });





  test('validateRuntimeFlags rejects invalid saved base URL values', async () => {
    const { validateRuntimeFlags } = await import('../../commands/runtime.js');

    const error = validateRuntimeFlags('codex', {
      apiKey: null,
      setupToken: null,
      baseUrl: 'not-a-url',
    });

    assert.match(error.error, /Invalid base URL/);
  });

  test('applyBaseUrl writes Claude and Codex base URLs to the expected config', async () => {
    const runtimeModule = await import('../../commands/runtime.js');

    assert.equal(runtimeModule.applyBaseUrl('claude', 'https://claude-proxy.example.com'), true);
    assert.equal(runtimeModule.applyBaseUrl('codex', 'https://codex-proxy.example.com/v1'), true);

    const envContent = fs.readFileSync(path.join(process.env.ZYLOS_DIR, '.env'), 'utf8');
    assert.match(envContent, /ANTHROPIC_BASE_URL=https:\/\/claude-proxy\.example\.com/);
    assert.match(envContent, /OPENAI_BASE_URL=https:\/\/codex-proxy\.example\.com\/v1/);

    const claudeSettings = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.claude', 'settings.json'), 'utf8'));
    assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, 'https://claude-proxy.example.com');

    const codexConfig = fs.readFileSync(path.join(tmpRoot, '.codex', 'config.toml'), 'utf8');
    assert.match(codexConfig, /openai_base_url = "https:\/\/codex-proxy\.example\.com\/v1"/);
  });
});
