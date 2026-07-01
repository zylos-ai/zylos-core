import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const tmpDirs = [];

// Install a fake `codex` binary BEFORE importing the adapter — CODEX_BIN is
// captured at module load. The fake mimics the real CLI's quirk: it writes its
// status line to STDERR and exits 0 in BOTH states. Per-test output is driven
// by FAKE_CODEX_STATUS so checkAuth()'s glue path can be asserted directly.
// NOTE: kept OUT of tmpDirs — the per-test afterEach drains tmpDirs, which would
// delete this binary before later tests run. Cleaned once via after() below.
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-fakebin-'));
const fakeCodexPath = path.join(fakeBinDir, 'codex');
fs.writeFileSync(
  fakeCodexPath,
  '#!/usr/bin/env bash\nif [ -n "$FAKE_CODEX_EXIT" ]; then exit "$FAKE_CODEX_EXIT"; fi\necho "${FAKE_CODEX_STATUS:-Not logged in}" >&2\nexit 0\n',
  { mode: 0o755 }
);
process.env.CODEX_BIN = fakeCodexPath;
after(() => { try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch {} });

const { CodexAdapter } = await import('../runtime/codex.js');

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

  delete process.env.FAKE_CODEX_STATUS;
  delete process.env.FAKE_CODEX_EXIT;
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

    assert.equal(result.status, 'success');
    assert.equal(requestedUrl, 'https://proxy.example.com/v1/models');
  });

  it('API key auth checks return failure on 401', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;

    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }, null, 2) + '\n',
      'utf8'
    );

    global.fetch = async () => ({ status: 401 });

    const adapter = new CodexAdapter({});
    const result = await adapter.checkAuth();

    assert.equal(result.status, 'failure');
    assert.equal(result.reason, 'http_probe_401');
  });

  it('API key auth checks return uncertain on 429 and 5xx', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;

    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }, null, 2) + '\n',
      'utf8'
    );

    const adapter = new CodexAdapter({});

    global.fetch = async () => ({ status: 429 });
    assert.equal((await adapter.checkAuth()).status, 'uncertain');

    global.fetch = async () => ({ status: 503 });
    assert.equal((await adapter.checkAuth()).status, 'uncertain');
  });

  it('API key auth checks return uncertain on network errors', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;

    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }, null, 2) + '\n',
      'utf8'
    );

    global.fetch = async () => {
      throw new Error('network down');
    };

    const adapter = new CodexAdapter({});
    const result = await adapter.checkAuth();

    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'http_probe_network_error');
  });

  // Regression guard: `codex login status` exits 0 even when logged out, so a
  // non-throwing execFile call must NOT be read as authenticated. This is the
  // exact false-pass on the runtime-switch / health-probe gate that the PR fixes.
  it('chatgpt/no-auth: returns not_logged_in when codex login status exits 0 with "Not logged in" on stderr', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome; // no ~/.codex/auth.json → falls to login-status branch
    process.env.FAKE_CODEX_STATUS = 'Not logged in';

    const adapter = new CodexAdapter({});
    const result = await adapter.checkAuth();

    assert.equal(result.status, 'failure');
    assert.equal(result.reason, 'not_logged_in');
  });

  it('chatgpt/no-auth: returns ok when codex login status reports "Logged in" on stderr (exit 0)', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;
    process.env.FAKE_CODEX_STATUS = 'Logged in using ChatGPT';

    const adapter = new CodexAdapter({});
    const result = await adapter.checkAuth();

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'codex_login_status');
  });

  it('chatgpt/no-auth: returns uncertain when codex login status output is unparseable', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;
    process.env.FAKE_CODEX_STATUS = 'Unexpected status text';

    const adapter = new CodexAdapter({});
    const result = await adapter.checkAuth();

    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'codex_login_status_uncertain');
  });

  it('chatgpt/no-auth: returns uncertain when codex login status cannot run', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-auth-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;
    process.env.FAKE_CODEX_EXIT = '127';

    const adapter = new CodexAdapter({});
    const result = await adapter.checkAuth();

    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'codex_login_status_unavailable');
  });
});
