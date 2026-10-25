import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-base-url-'));
process.env.HOME = tmpRoot;
process.env.ZYLOS_DIR = path.join(tmpRoot, 'zylos-home');
fs.mkdirSync(process.env.ZYLOS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.ZYLOS_DIR, '.env'), '', 'utf8');

describe('runtime base URL support', () => {
  test('review P1: readiness checks installed project hooks, and rejects missing/stale hooks (M9)', async t => {
    const { runtimeHooksReady, executeRuntimeSwitch } = await import('../../commands/runtime.js');
    const { syncRuntimeHooks } = await import('../sync-settings-hooks.js');
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
