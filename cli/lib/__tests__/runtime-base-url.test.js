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
  test('reports pending migration when the selected runtime has no legacy output', async () => {
    const { prepareRuntimeInstruction } = await import('../../commands/runtime.js');
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-instructions-'));
    const pending = prepareRuntimeInstruction('codex', { zylosDir });
    assert.equal(pending.pendingMigration, true);
    fs.writeFileSync(path.join(zylosDir, 'AGENTS.md'), 'legacy instructions\n');
    const preserved = prepareRuntimeInstruction('codex', { zylosDir });
    assert.equal(preserved.pendingMigration, false);
    fs.rmSync(zylosDir, { recursive: true, force: true });
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

  test('checkRuntimeAuthGate skips adapter probe for standalone --no-validate', async () => {
    const { checkRuntimeAuthGate, parseRuntimeFlags } = await import('../../commands/runtime.js');
    let checkAuthCalls = 0;

    const result = await checkRuntimeAuthGate(
      'codex',
      { checkAuth: async () => { checkAuthCalls++; return { status: 'failure', reason: 'should_not_run' }; } },
      parseRuntimeFlags(['--no-validate']),
      { log: () => {}, error: () => {}, exit: () => { throw new Error('exit should not be called'); } }
    );

    assert.equal(result.skipped, true);
    assert.equal(checkAuthCalls, 0);
  });

  test('checkRuntimeAuthGate proceeds only on success and exits for failure or uncertain', async () => {
    const { checkRuntimeAuthGate, parseRuntimeFlags } = await import('../../commands/runtime.js');
    const parsed = parseRuntimeFlags([]);

    const success = await checkRuntimeAuthGate(
      'claude',
      { checkAuth: async () => ({ status: 'success', reason: 'cli_probe' }) },
      parsed,
      { log: () => {}, error: () => {}, exit: () => { throw new Error('exit should not be called'); } }
    );
    assert.equal(success.status, 'success');

    for (const status of ['failure', 'uncertain']) {
      let exitCode = null;
      await assert.rejects(
        () => checkRuntimeAuthGate(
          'claude',
          { checkAuth: async () => ({ status, reason: `test_${status}` }) },
          parsed,
          { log: () => {}, error: () => {}, exit: (code) => { exitCode = code; throw new Error(`exit ${code}`); } }
        ),
        /exit 2/
      );
      assert.equal(exitCode, 2);
    }
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
