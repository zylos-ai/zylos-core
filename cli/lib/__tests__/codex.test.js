import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const tmpDirs = [];

// Install a fake `codex` binary before importing the adapter. Preserve coverage
// for CLI versions that report logged-out status with exit 0, as well as the
// usual stderr status line. Per-test output is driven by FAKE_CODEX_STATUS;
// nonzero-exit parsing is covered by the runtime auth-probe tests.
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

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

let originalHome;
let originalCodexHome;
let originalFetch;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalCodexHome = process.env.CODEX_HOME;
  // Default-path cases must not inherit a different credential/config directory.
  delete process.env.CODEX_HOME;
  originalFetch = global.fetch;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;

  if (originalFetch === undefined) delete global.fetch;
  else global.fetch = originalFetch;

  delete process.env.FAKE_CODEX_STATUS;
  delete process.env.FAKE_CODEX_EXIT;
});

const { checkAuth } = await import('../runtime/codex/auth.js');

describe('Codex auth checks', () => {

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

    const result = await checkAuth();

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

    global.fetch = async () => ({ status: 429 });
    assert.equal((await checkAuth()).status, 'uncertain');

    global.fetch = async () => ({ status: 503 });
    assert.equal((await checkAuth()).status, 'uncertain');
  });

});
