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

const { isRateLimitError, withRateLimitRetrySync, withRateLimitRetryAsync, fetchRawFile } =
  await import('../github.js');

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
    // Token present: each operation attempt = public + authenticated call.
    // Attempt 1 (calls 1-2) is fully rate limited; the retry's public
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
    // public + authenticated within the single attempt, no retries
    assert.equal(fake.calls(), 2);
  });
});
