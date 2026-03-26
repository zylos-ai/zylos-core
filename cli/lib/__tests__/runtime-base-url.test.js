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
  test('runtime command exports helpers for base-url parsing and validation', async () => {
    const runtimeModule = await import('../../commands/runtime.js');

    assert.equal(typeof runtimeModule.parseRuntimeFlags, 'function');
    assert.equal(typeof runtimeModule.validateRuntimeFlags, 'function');
    assert.equal(typeof runtimeModule.showHelp, 'function');
  });

  test('parseRuntimeFlags accepts --save-base-url and showHelp shows it', async () => {
    const runtimeModule = await import('../../commands/runtime.js');
    const flags = runtimeModule.parseRuntimeFlags(['--save-apikey', 'sk-test', '--save-base-url', 'https://proxy.example.com/v1']);

    assert.equal(flags.apiKey, 'sk-test');
    assert.equal(flags.baseUrl, 'https://proxy.example.com/v1');

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
