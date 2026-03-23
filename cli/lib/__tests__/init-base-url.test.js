import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('base URL support', () => {
  test('init command exports helpers for base-url parsing and validation', async () => {
    const initModule = await import('../../commands/init.js');

    assert.equal(typeof initModule.parseInitFlags, 'function');
    assert.equal(typeof initModule.validateInitOptions, 'function');
    assert.equal(typeof initModule.printInitHelp, 'function');
  });

  test('parseInitFlags accepts runtime-specific base URL flags and printInitHelp shows them', async () => {
    const initModule = await import('../../commands/init.js');
    const opts = initModule.parseInitFlags([
      '--runtime', 'codex',
      '--base-url', 'https://claude-proxy.example.com',
      '--codex-base-url', 'https://proxy.example.com/v1',
    ]);

    assert.equal(opts.runtime, 'codex');
    assert.equal(opts.baseUrl, 'https://claude-proxy.example.com');
    assert.equal(opts.codexBaseUrl, 'https://proxy.example.com/v1');

    const originalLog = console.log;
    let output = '';
    console.log = (line = '') => {
      output += `${line}\n`;
    };

    try {
      initModule.printInitHelp();
    } finally {
      console.log = originalLog;
    }

    assert.match(output, /--base-url <url>/);
    assert.match(output, /--codex-base-url <url>/);
  });

  test('resolveFromEnv reads base URL env vars without overriding explicit flags', async () => {
    const initModule = await import('../../commands/init.js');
    const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

    process.env.ANTHROPIC_BASE_URL = 'https://claude-env.example.com';
    process.env.OPENAI_BASE_URL = 'https://codex-env.example.com/v1';

    try {
      const envOnly = initModule.parseInitFlags([]);
      initModule.resolveFromEnv(envOnly);
      assert.equal(envOnly.baseUrl, 'https://claude-env.example.com');
      assert.equal(envOnly.codexBaseUrl, 'https://codex-env.example.com/v1');

      const explicitFlags = initModule.parseInitFlags([
        '--base-url', 'https://claude-flag.example.com',
        '--codex-base-url', 'https://codex-flag.example.com/v1',
      ]);
      initModule.resolveFromEnv(explicitFlags);
      assert.equal(explicitFlags.baseUrl, 'https://claude-flag.example.com');
      assert.equal(explicitFlags.codexBaseUrl, 'https://codex-flag.example.com/v1');
    } finally {
      if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;

      if (originalOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    }
  });

  test('writeCodexConfig writes openai_base_url when OPENAI_BASE_URL is set', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-base-url-'));
    const originalHome = process.env.HOME;
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

    process.env.HOME = tmpRoot;
    process.env.OPENAI_BASE_URL = 'https://openai-proxy.example.com/v1';

    try {
      const { writeCodexConfig } = await import('../runtime-setup.js');

      assert.equal(writeCodexConfig('/tmp/zylos-project'), true);

      const configPath = path.join(tmpRoot, '.codex', 'config.toml');
      const config = fs.readFileSync(configPath, 'utf8');
      assert.match(config, /openai_base_url = "https:\/\/openai-proxy\.example\.com\/v1"/);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;

      if (originalOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;

      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('writeCodexConfig writes openai_base_url when explicit opts.openaiBaseUrl is provided', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-base-url-opt-'));
    const originalHome = process.env.HOME;
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

    process.env.HOME = tmpRoot;
    delete process.env.OPENAI_BASE_URL;

    try {
      const { writeCodexConfig } = await import('../runtime-setup.js');

      assert.equal(
        writeCodexConfig('/tmp/zylos-project', { openaiBaseUrl: 'https://explicit-proxy.example.com/v1' }),
        true
      );

      const configPath = path.join(tmpRoot, '.codex', 'config.toml');
      const config = fs.readFileSync(configPath, 'utf8');
      assert.match(config, /openai_base_url = "https:\/\/explicit-proxy\.example\.com\/v1"/);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;

      if (originalOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;

      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('validateInitOptions rejects invalid base URL values for both runtimes', async () => {
    const { validateInitOptions } = await import('../../commands/init.js');

    const claudeError = validateInitOptions({
      setupToken: null,
      apiKey: null,
      runtime: 'claude',
      timezone: null,
      domain: null,
      baseUrl: 'not-a-url',
    });
    const codexError = validateInitOptions({
      setupToken: null,
      apiKey: null,
      runtime: 'codex',
      timezone: null,
      domain: null,
      baseUrl: null,
      codexBaseUrl: 'still-not-a-url',
    });

    assert.match(claudeError, /Invalid base URL/);
    assert.match(codexError, /Invalid Codex base URL/);
  });
});
