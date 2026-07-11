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

const { downloadArchive } = await import('../download.js');

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
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

// Fake curl that always fails with the given status; fake gh that reports no
// auth, so getGitHubToken() resolves to null on its first (cached) probe.
function installFailingCurl({ status }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-fake-'));
  tmpDirs.push(dir);
  const callsFile = path.join(dir, 'calls');
  const script = `#!/bin/sh
n=$(cat "${callsFile}" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${callsFile}"
echo "curl: (22) The requested URL returned error: ${status}" >&2
exit 22
`;
  fs.writeFileSync(path.join(dir, 'curl'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return {
    calls: () => {
      if (!fs.existsSync(callsFile)) return 0;
      return Number(fs.readFileSync(callsFile, 'utf8').trim());
    },
  };
}

function makeDestDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-dest-'));
  tmpDirs.push(dir);
  return dir;
}

describe('downloadArchive no-token fallback (fake curl on PATH)', () => {
  it('makes exactly one public request per failed no-token attempt and surfaces the error (#705)', () => {
    process.env.ZYLOS_GH_RETRY_DELAY_MS = '';
    const fake = installFailingCurl({ status: '404' });

    const result = downloadArchive('org/repo', '1.0.0', makeDestDir());

    assert.equal(result.success, false);
    assert.match(result.error, /404/);
    assert.equal(fake.calls(), 1);
  });

  it('retries no-token rate limiting via the outer loop only (#705)', () => {
    process.env.ZYLOS_GH_RETRY_DELAY_MS = '0';
    const fake = installFailingCurl({ status: '403' });

    const result = downloadArchive('org/repo', '1.0.0', makeDestDir());

    assert.equal(result.success, false);
    assert.match(result.error, /403/);
    // 1 public call per retry round: initial attempt + one configured retry
    assert.equal(fake.calls(), 2);
  });
});
