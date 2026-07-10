import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const origEnv = {};
for (const key of ['ZYLOS_GH_RETRY_DELAY_MS', 'GITHUB_TOKEN', 'GH_TOKEN', 'PATH']) {
  origEnv[key] = process.env[key];
}
const tmpDirs = [];
let freshImportId = 0;

const { isRateLimitError, withRateLimitRetrySync, withRateLimitRetryAsync, fetchRawFile } =
  await import('../github.js');

function importFreshGitHub() {
  freshImportId += 1;
  return import(`../github.js?token-order-test=${freshImportId}`);
}

beforeEach(() => {
  // Fast retries so tests don't sleep for real
  process.env.ZYLOS_GH_RETRY_DELAY_MS = '10,10';
});

afterEach(() => {
  for (const [key, value] of Object.entries(origEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function curlError(status) {
  const err = new Error('Command failed: curl -fsSL https://api.github.com/repos/org/repo/tags');
  err.stderr = `curl: (22) The requested URL returned error: ${status}`;
  return err;
}

describe('isRateLimitError', () => {
  it('matches curl 403 failures', () => {
    assert.equal(isRateLimitError(curlError('403')), true);
  });

  it('matches curl 429 failures', () => {
    assert.equal(isRateLimitError(curlError('429')), true);
  });

  it('matches older curl messages with status text', () => {
    assert.equal(isRateLimitError(curlError('403 Forbidden')), true);
  });

  it('rejects other HTTP errors', () => {
    assert.equal(isRateLimitError(curlError('404')), false);
    assert.equal(isRateLimitError(curlError('500')), false);
  });

  it('rejects network errors without an HTTP status', () => {
    const err = new Error('Command failed: curl');
    err.stderr = 'curl: (6) Could not resolve host: api.github.com';
    assert.equal(isRateLimitError(err), false);
  });

  it('rejects status digits appearing elsewhere (e.g. in URLs)', () => {
    const err = new Error('Command failed: curl https://api.github.com/repos/org/repo-403/tags');
    err.stderr = 'curl: (22) The requested URL returned error: 404';
    assert.equal(isRateLimitError(err), false);
  });
});

describe('withRateLimitRetrySync', () => {
  it('returns immediately on first success without retrying', () => {
    let calls = 0;
    const result = withRateLimitRetrySync(() => { calls++; return 'ok'; }, 'test');
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries rate-limit failures and succeeds on a later attempt', () => {
    let calls = 0;
    const result = withRateLimitRetrySync(() => {
      calls++;
      if (calls < 3) throw curlError('403');
      return 'recovered';
    }, 'test');
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('gives up after 2 retries (3 attempts total)', () => {
    let calls = 0;
    assert.throws(
      () => withRateLimitRetrySync(() => { calls++; throw curlError('429'); }, 'test'),
      err => /returned error: 429/.test(err.stderr)
    );
    assert.equal(calls, 3);
  });

  it('does not retry non-rate-limit failures', () => {
    let calls = 0;
    assert.throws(
      () => withRateLimitRetrySync(() => { calls++; throw curlError('404'); }, 'test'),
      err => /returned error: 404/.test(err.stderr)
    );
    assert.equal(calls, 1);
  });

  it('disables retries when ZYLOS_GH_RETRY_DELAY_MS is empty', () => {
    process.env.ZYLOS_GH_RETRY_DELAY_MS = '';
    let calls = 0;
    assert.throws(
      () => withRateLimitRetrySync(() => { calls++; throw curlError('403'); }, 'test'),
      err => /returned error: 403/.test(err.stderr)
    );
    assert.equal(calls, 1);
  });
});

describe('withRateLimitRetryAsync', () => {
  it('retries rate-limit failures and succeeds on a later attempt', async () => {
    let calls = 0;
    const result = await withRateLimitRetryAsync(async () => {
      calls++;
      if (calls < 2) throw curlError('403');
      return 'recovered';
    }, 'test');
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  it('gives up after 2 retries (3 attempts total)', async () => {
    let calls = 0;
    await assert.rejects(
      withRateLimitRetryAsync(async () => { calls++; throw curlError('403'); }, 'test'),
      err => /returned error: 403/.test(err.stderr)
    );
    assert.equal(calls, 3);
  });

  it('does not retry non-rate-limit failures', async () => {
    let calls = 0;
    await assert.rejects(
      withRateLimitRetryAsync(async () => { calls++; throw curlError('500'); }, 'test'),
      err => /returned error: 500/.test(err.stderr)
    );
    assert.equal(calls, 1);
  });
});

describe('fetchRawFile wiring (fake curl on PATH)', () => {
  function installFakeCurl({ failuresBeforeSuccess, status }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fake-curl-'));
    tmpDirs.push(dir);
    const stateFile = path.join(dir, 'calls');
    const script = `#!/bin/sh
n=$(cat "${stateFile}" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${stateFile}"
if [ $n -le ${failuresBeforeSuccess} ]; then
  echo "curl: (22) The requested URL returned error: ${status}" >&2
  exit 22
fi
echo "file-content"
`;
    const curlPath = path.join(dir, 'curl');
    fs.writeFileSync(curlPath, script, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    return {
      calls: () => Number(fs.readFileSync(stateFile, 'utf8').trim()),
    };
  }

  it('recovers when rate limiting clears within the retry budget', () => {
    // Token present: each operation attempt = authenticated + public call.
    // Attempt 1 (calls 1-2) is fully rate limited; the retry's authenticated
    // call (call 3) succeeds.
    process.env.GITHUB_TOKEN = 'test-token';
    const fake = installFakeCurl({ failuresBeforeSuccess: 2, status: '403' });
    const content = fetchRawFile('org/repo', 'SKILL.md');
    assert.equal(content.trim(), 'file-content');
    assert.equal(fake.calls(), 3);
  });

  it('fails fast on non-rate-limit errors', () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const fake = installFakeCurl({ failuresBeforeSuccess: 99, status: '404' });
    assert.throws(() => fetchRawFile('org/repo', 'SKILL.md'));
    // authenticated + public within the single attempt, no retries
    assert.equal(fake.calls(), 2);
  });
});

describe('GitHub API authentication order (fake curl on PATH)', () => {
  function installRecordingCommands({ failAuthenticated = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-github-order-'));
    tmpDirs.push(dir);
    const callsFile = path.join(dir, 'curl-calls');
    const curlScript = `#!/bin/sh
printf '%s\\n' "$*" >> "${callsFile}"
case "$*" in
  *"Authorization: Bearer"*)
    if [ "${failAuthenticated ? 'yes' : 'no'}" = "yes" ]; then
      echo "curl: (22) The requested URL returned error: 403" >&2
      exit 22
    fi
    ;;
esac
case "$*" in
  *"/tags?per_page=100"*) printf '%s\\n' '[{"name":"v1.2.3"}]' ;;
  *) printf '%s\\n' 'file-content' ;;
esac
`;
    fs.writeFileSync(path.join(dir, 'curl'), curlScript, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    return {
      calls() {
        if (!fs.existsSync(callsFile)) return [];
        return fs.readFileSync(callsFile, 'utf8').trim().split('\n');
      },
    };
  }

  it('uses authenticated API calls first for sync and async tag queries', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const fake = installRecordingCommands();
    const { fetchLatestTag, fetchLatestTagAsync } = await importFreshGitHub();

    assert.equal(fetchLatestTag('org/repo'), '1.2.3');
    assert.equal(await fetchLatestTagAsync('org/repo'), '1.2.3');

    const calls = fake.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call, /Authorization: Bearer test-token/);
      assert.match(call, /api\.github\.com\/repos\/org\/repo\/tags\?per_page=100/);
    }
  });

  it('uses the authenticated contents API first for raw files', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const fake = installRecordingCommands();
    const { fetchRawFile: fetchRawFileFresh } = await importFreshGitHub();

    assert.equal(fetchRawFileFresh('org/repo', 'SKILL.md').trim(), 'file-content');

    const [call] = fake.calls();
    assert.match(call, /Authorization: Bearer test-token/);
    assert.match(call, /Accept: application\/vnd\.github\.raw\+json/);
    assert.match(call, /api\.github\.com\/repos\/org\/repo\/contents\/SKILL\.md\?ref=main/);
  });

  it('falls back to public endpoints when an authenticated request fails', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const fake = installRecordingCommands({ failAuthenticated: true });
    const { fetchLatestTag, fetchLatestTagAsync, fetchRawFile: fetchRawFileFresh } =
      await importFreshGitHub();

    assert.equal(fetchLatestTag('org/repo'), '1.2.3');
    assert.equal(await fetchLatestTagAsync('org/repo'), '1.2.3');
    assert.equal(fetchRawFileFresh('org/repo', 'SKILL.md').trim(), 'file-content');

    const calls = fake.calls();
    assert.equal(calls.length, 6);
    assert.match(calls[0], /Authorization: Bearer test-token/);
    assert.doesNotMatch(calls[1], /Authorization:/);
    assert.match(calls[1], /api\.github\.com\/repos\/org\/repo\/tags\?per_page=100/);
    assert.match(calls[2], /Authorization: Bearer test-token/);
    assert.doesNotMatch(calls[3], /Authorization:/);
    assert.match(calls[3], /api\.github\.com\/repos\/org\/repo\/tags\?per_page=100/);
    assert.match(calls[4], /Authorization: Bearer test-token/);
    assert.doesNotMatch(calls[5], /Authorization:/);
    assert.match(calls[5], /raw\.githubusercontent\.com\/org\/repo\/main\/SKILL\.md/);
  });

  it('uses public endpoints directly when no token is available', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const fake = installRecordingCommands();
    const { fetchLatestTag, fetchLatestTagAsync, fetchRawFile: fetchRawFileFresh } =
      await importFreshGitHub();

    assert.equal(fetchLatestTag('org/repo'), '1.2.3');
    assert.equal(await fetchLatestTagAsync('org/repo'), '1.2.3');
    assert.equal(fetchRawFileFresh('org/repo', 'SKILL.md').trim(), 'file-content');

    const calls = fake.calls();
    assert.equal(calls.length, 3);
    assert.doesNotMatch(calls[0], /Authorization:/);
    assert.match(calls[0], /api\.github\.com\/repos\/org\/repo\/tags\?per_page=100/);
    assert.doesNotMatch(calls[1], /Authorization:/);
    assert.match(calls[1], /api\.github\.com\/repos\/org\/repo\/tags\?per_page=100/);
    assert.doesNotMatch(calls[2], /Authorization:/);
    assert.match(calls[2], /raw\.githubusercontent\.com\/org\/repo\/main\/SKILL\.md/);
  });
});
