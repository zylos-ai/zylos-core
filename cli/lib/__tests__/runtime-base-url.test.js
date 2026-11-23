import { runtimeAuthFixture } from './helpers/runtime-auth.js';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  test('invalid base URL errors never reflect credential-like URL contents', async () => {
    const { parseRuntimeFlags, validateRuntimeFlags } = await import('../../commands/runtime.js');
    const privatePart = 'private-url-value';
    for (const address of [`https://user:${privatePart}@example.com`, `https://example.com/?key=${privatePart}`, `https://example.com/#${privatePart}`, 'https://example.com?', 'https://example.com#']) {
      const result = validateRuntimeFlags(await runtimeAuthFixture('claude'), parseRuntimeFlags(['--save-base-url', address]));
      assert.ok(result?.error, 'credential-bearing URLs must be rejected');
      assert.ok(!JSON.stringify(result).includes(privatePart), 'validation must not reflect input');
    }
  });






  test('applyBaseUrl writes Claude and Codex base URLs to the expected config', async () => {
    const runtimeModule = await import('../../commands/runtime.js');

    assert.equal(runtimeModule.applyBaseUrl(await runtimeAuthFixture('claude'), 'https://claude-proxy.example.com'), true);
    assert.equal(runtimeModule.applyBaseUrl(await runtimeAuthFixture('codex'), 'https://codex-proxy.example.com/v1'), true);

    const envContent = fs.readFileSync(path.join(process.env.ZYLOS_DIR, '.env'), 'utf8');
    assert.match(envContent, /ANTHROPIC_BASE_URL=https:\/\/claude-proxy\.example\.com/);
    assert.match(envContent, /OPENAI_BASE_URL=https:\/\/codex-proxy\.example\.com\/v1/);

    // The Claude base URL goes to ~/zylos/.env only; ~/.claude/settings.json is not written.
    assert.equal(fs.existsSync(path.join(tmpRoot, '.claude', 'settings.json')), false);

    const codexConfig = fs.readFileSync(path.join(tmpRoot, '.codex', 'config.toml'), 'utf8');
    assert.match(codexConfig, /openai_base_url = "https:\/\/codex-proxy\.example\.com\/v1"/);
  });
});
