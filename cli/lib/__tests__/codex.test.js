import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const tmpDirs = [];

const { CodexAdapter, buildCodexBootstrapPrompt, isOnboardingPendingState } = await import('../runtime/codex.js');

function makeZylosDir(stateContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-bootstrap-test-'));
  tmpDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'memory', 'state.md'), stateContent, 'utf8');
  return tmpDir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

let originalHome;
let originalFetch;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalFetch = global.fetch;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalFetch === undefined) delete global.fetch;
  else global.fetch = originalFetch;
});

describe('Codex bootstrap onboarding guard', () => {
  it('detects onboarding pending from state.md content', () => {
    assert.equal(isOnboardingPendingState('- Status: pending\n'), true);
    assert.equal(isOnboardingPendingState('- Status: completed\n'), false);
  });

  it('waits for first real user message when onboarding is pending', () => {
    const zylosDir = makeZylosDir('# Active State\n\n## Onboarding\n- Status: pending\n');
    const prompt = buildCodexBootstrapPrompt(zylosDir);

    assert.match(prompt, /Do not run the startup follow-up trigger yet because onboarding is pending\./);
    assert.match(prompt, /Wait for the first real user message with a `reply via:` path/);
    assert.doesNotMatch(prompt, /node ".*session-start-prompt\.js"/);
  });

  it('includes session-start-prompt when onboarding is not pending', () => {
    const zylosDir = makeZylosDir('# Active State\n\n## Onboarding\n- Status: completed\n');
    const prompt = buildCodexBootstrapPrompt(zylosDir);

    assert.match(prompt, /node ".*session-start-prompt\.js"/);
    assert.match(prompt, /Then continue according to the latest control message and ongoing conversation context\./);
  });
});

describe('Codex auth checks', () => {
  it('uses the configured custom base URL for API key auth checks', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;

    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }, null, 2) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      'openai_base_url = "https://proxy.example.com/v1"\n',
      'utf8'
    );

    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = String(url);
      return { status: 200 };
    };

    const adapter = new CodexAdapter({});
    const result = await adapter.checkAuth();

    assert.equal(result.ok, true);
    assert.equal(requestedUrl, 'https://proxy.example.com/v1/models');
  });
});
