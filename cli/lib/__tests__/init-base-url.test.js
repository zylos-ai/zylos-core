import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
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

  test('isCustomAnthropicEndpoint recognises official vs custom hosts', async () => {
    const { isCustomAnthropicEndpoint } = await import('../../commands/init.js');

    assert.equal(isCustomAnthropicEndpoint(null), false);
    assert.equal(isCustomAnthropicEndpoint(undefined), false);
    assert.equal(isCustomAnthropicEndpoint(''), false);
    assert.equal(isCustomAnthropicEndpoint('https://api.anthropic.com'), false);
    assert.equal(isCustomAnthropicEndpoint('https://api.anthropic.com/'), false);
    assert.equal(isCustomAnthropicEndpoint('https://API.Anthropic.com'), false);
    assert.equal(isCustomAnthropicEndpoint('https://beta.anthropic.com/v1'), false);
    assert.equal(isCustomAnthropicEndpoint('https://api.lvlng.xyz'), true);
    assert.equal(isCustomAnthropicEndpoint('http://api.lvlng.xyz'), true);
    assert.equal(isCustomAnthropicEndpoint('https://claude-proxy.example.com/v1'), true);
    assert.equal(isCustomAnthropicEndpoint('not-a-url'), true);
  });

  test('validateInitOptions rejects non-sk-ant- API keys against the official endpoint', async () => {
    const { validateInitOptions } = await import('../../commands/init.js');

    const err = validateInitOptions({
      setupToken: null,
      apiKey: 'custom-1234567890abcdef',
      runtime: 'claude',
      timezone: null,
      domain: null,
      baseUrl: null,
    });

    assert.match(err, /Invalid API key/);
    assert.match(err, /Custom endpoints: set --base-url/);
  });

  test('validateInitOptions accepts non-sk-ant- API keys when a custom base URL is set', async () => {
    const { validateInitOptions } = await import('../../commands/init.js');

    const err = validateInitOptions({
      setupToken: null,
      apiKey: 'custom-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      runtime: 'claude',
      timezone: null,
      domain: null,
      baseUrl: 'http://api.lvlng.xyz',
    });

    assert.equal(err, null);
  });

  test('validateInitOptions still rejects setup tokens in --api-key, even on custom endpoints', async () => {
    const { validateInitOptions } = await import('../../commands/init.js');

    const err = validateInitOptions({
      setupToken: null,
      apiKey: 'sk-ant-oat-abc123',
      runtime: 'claude',
      timezone: null,
      domain: null,
      baseUrl: 'https://claude-proxy.example.com',
    });

    assert.match(err, /looks like a setup token/);
  });

  test('validateInitOptions still accepts sk-ant- API keys against the official endpoint', async () => {
    const { validateInitOptions } = await import('../../commands/init.js');

    const err = validateInitOptions({
      setupToken: null,
      apiKey: 'sk-ant-api03-abcdef',
      runtime: 'claude',
      timezone: null,
      domain: null,
      baseUrl: null,
    });

    assert.equal(err, null);
  });
});

describe('resolveVerifyEndpoint', () => {
  test('falls back to api.anthropic.com when baseUrl is absent or unusable', async () => {
    const { resolveVerifyEndpoint } = await import('../../commands/init.js');

    const def = { hostname: 'api.anthropic.com', port: 443, protocol: 'https:', path: '/v1/messages' };
    assert.deepEqual(resolveVerifyEndpoint(null), def);
    assert.deepEqual(resolveVerifyEndpoint(undefined), def);
    assert.deepEqual(resolveVerifyEndpoint(''), def);
    assert.deepEqual(resolveVerifyEndpoint('not-a-url'), def);
    assert.deepEqual(resolveVerifyEndpoint('ftp://ftp.example.com/'), def);
  });

  test('parses http/https hosts, ports, and base paths', async () => {
    const { resolveVerifyEndpoint } = await import('../../commands/init.js');

    assert.deepEqual(resolveVerifyEndpoint('http://api.lvlng.xyz'), {
      hostname: 'api.lvlng.xyz',
      port: 80,
      protocol: 'http:',
      path: '/v1/messages',
    });
    assert.deepEqual(resolveVerifyEndpoint('https://proxy.example.com/'), {
      hostname: 'proxy.example.com',
      port: 443,
      protocol: 'https:',
      path: '/v1/messages',
    });
    assert.deepEqual(resolveVerifyEndpoint('https://proxy.example.com/anthropic'), {
      hostname: 'proxy.example.com',
      port: 443,
      protocol: 'https:',
      path: '/anthropic/v1/messages',
    });
    assert.deepEqual(resolveVerifyEndpoint('http://localhost:8080'), {
      hostname: 'localhost',
      port: 8080,
      protocol: 'http:',
      path: '/v1/messages',
    });
  });
});

describe('verifyApiKey', () => {
  // Starts a throwaway HTTP server that replies with the given status code and
  // returns the baseUrl callers should pass to verifyApiKey.
  async function startStubServer(statusCode) {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = statusCode;
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return { server, baseUrl: `http://127.0.0.1:${port}` };
  }

  test('returns valid=true when custom endpoint responds with non-401 (e.g. 400)', async () => {
    const { verifyApiKey } = await import('../../commands/init.js');
    const { server, baseUrl } = await startStubServer(400);
    try {
      const result = await verifyApiKey('custom-fake', baseUrl);
      assert.deepEqual(result, { valid: true });
    } finally {
      server.close();
    }
  });

  test('returns valid=false with authError=true on explicit 401 from any endpoint', async () => {
    const { verifyApiKey } = await import('../../commands/init.js');
    const { server, baseUrl } = await startStubServer(401);
    try {
      const result = await verifyApiKey('custom-bad', baseUrl);
      assert.deepEqual(result, { valid: false, authError: true });
    } finally {
      server.close();
    }
  });

  test('custom endpoint: network error returns valid=true with unverified=true', async () => {
    const { verifyApiKey } = await import('../../commands/init.js');
    // Port 1 is almost always closed — connect will fail immediately.
    const result = await verifyApiKey('custom-fake', 'http://127.0.0.1:1');
    assert.equal(result.valid, true);
    assert.equal(result.unverified, true);
    assert.equal(result.reason, 'network');
  });

  test('custom endpoint 200 response is treated as valid (proxy contract-agnostic)', async () => {
    const { verifyApiKey } = await import('../../commands/init.js');
    const { server, baseUrl } = await startStubServer(200);
    try {
      const result = await verifyApiKey('custom-fake', baseUrl);
      assert.deepEqual(result, { valid: true });
    } finally {
      server.close();
    }
  });
});
