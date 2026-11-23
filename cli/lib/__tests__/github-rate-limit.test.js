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

const { withRateLimitRetrySync } =
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

describe('withRateLimitRetrySync', () => {

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

});

describe('GitHub API authentication order (fake curl on PATH)', () => {
  function installRecordingCommands({
    failAuthenticated = false,
    authenticatedStatus = '403',
    publicFailuresBeforeSuccess = 0,
    publicStatus = '500',
  } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-github-order-'));
    tmpDirs.push(dir);
    const callsFile = path.join(dir, 'curl-calls');
    const publicCallsFile = path.join(dir, 'public-calls');
    const curlScript = `#!/bin/sh
args="$*"
input=""
case "$args" in
  *"-H @-"*) input=$(cat) ;;
esac
flat_input=$(printf '%s' "$input" | tr '\\n' '|')
printf '%s\\t%s\\n' "$args" "$flat_input" >> "${callsFile}"
case "$input" in
  *"Authorization: Bearer"*)
    if [ "${failAuthenticated ? 'yes' : 'no'}" = "yes" ]; then
      echo "curl: (22) The requested URL returned error: ${authenticatedStatus}" >&2
      exit 22
    fi
    ;;
esac
public_calls=$(cat "${publicCallsFile}" 2>/dev/null || echo 0)
public_calls=$((public_calls+1))
echo "$public_calls" > "${publicCallsFile}"
if [ "$public_calls" -le "${publicFailuresBeforeSuccess}" ]; then
  echo "curl: (22) The requested URL returned error: ${publicStatus}" >&2
  exit 22
fi
case "$args" in
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
        return fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => {
          const [args, input = ''] = line.split('\t');
          return { args, input };
        });
      },
      publicCalls() {
        if (!fs.existsSync(publicCallsFile)) return 0;
        return Number(fs.readFileSync(publicCallsFile, 'utf8').trim());
      },
    };
  }

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
    assert.match(calls[0].input, /Authorization: Bearer test-token/);
    assert.equal(calls[1].input, '');
    assert.match(calls[1].args, /api\.github\.com\/repos\/org\/repo\/tags\?per_page=100/);
    assert.match(calls[2].input, /Authorization: Bearer test-token/);
    assert.equal(calls[3].input, '');
    assert.match(calls[3].args, /api\.github\.com\/repos\/org\/repo\/tags\?per_page=100/);
    assert.match(calls[4].input, /Authorization: Bearer test-token/);
    assert.equal(calls[5].input, '');
    assert.match(calls[5].args, /raw\.githubusercontent\.com\/org\/repo\/main\/SKILL\.md/);
  });


});
