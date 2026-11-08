import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { observerArtifactFor } from '../src/lib/observer-artifacts.js';
import { ObserverInstaller } from '../src/lib/observer-installer.js';

const enabled = process.env.ZYLOS_OBSERVER_DOWNLOAD_INTEGRATION === '1';
const execFileAsync = promisify(execFile);

// Run when release transport, redirects, catalog pins, or installation validation change.
// Skip offline/default runs. This case requires the official isolated Node runner:
// private HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR, checked before any request.
// Machines using proxy environment variables must also set NODE_USE_ENV_PROXY=1.
// No tmux server or database is used. Large artifacts may use a separate private
// test root outside ~/zylos (shared-memory TMPDIR may be too small or noexec).
// All artifacts are removed by t.after, including on failure.
test('real release API fallback download matches both pinned digests', {
  skip: !enabled,
  timeout: 150_000,
}, async (t) => {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    const value = path.resolve(process.env[key] || realHome);
    assert.equal(value === realHome || value.startsWith(`${realHome}${path.sep}`), false, `${key} must be isolated`);
    t.diagnostic(`${key}=${value}`);
  }
  assert.equal(os.homedir(), process.env.HOME);
  const artifactRoot = fs.realpathSync(process.env.ZYLOS_OBSERVER_DOWNLOAD_TEST_ROOT || os.tmpdir());
  const liveRoot = path.join(realHome, 'zylos');
  assert.equal(artifactRoot === liveRoot || artifactRoot.startsWith(`${liveRoot}${path.sep}`), false);
  const root = fs.mkdtempSync(path.join(artifactRoot, 'observer-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = observerArtifactFor();
  assert.ok(artifact, 'real download requires a supported host platform');
  const requests = [];
  const installer = new ObserverInstaller({
    dataDir: path.join(root, 'data'),
    artifact,
    exec: (file, args, options) => execFileAsync(file, args, { ...options, signal: t.signal }),
    fetchImpl: async (url, options) => {
      assert.ok(requests.length < 16, 'bounded release requests');
      if (url === artifact.url) {
        requests.push('forced direct HTTP 504');
        return new Response('', { status: 504 });
      }
      const response = await fetch(url, options);
      const location = response.headers.get('location');
      requests.push(`${new URL(url).hostname} HTTP ${response.status}${location ? ` -> ${new URL(location, url).hostname}` : ''}`);
      return response;
    },
  });
  t.diagnostic(`dataDir=${path.join(root, 'data')}; tmux=N/A; database=N/A`);
  try {
    const installed = await installer.install({ signal: t.signal });
    assert.equal(installed.state, 'installed');
    const record = JSON.parse(fs.readFileSync(installer.paths.installedManifest, 'utf8'));
    assert.equal(record.archiveSha256, artifact.archiveSha256);
    const binaryDigest = crypto.createHash('sha256').update(fs.readFileSync(installed.binaryPath)).digest('hex');
    assert.equal(binaryDigest, artifact.binarySha256);
    assert.equal((await installer.verify()).state, 'installed');
    t.diagnostic(`archiveSha256=${record.archiveSha256}; binarySha256=${binaryDigest}; version=${installed.version}`);
  } finally {
    t.diagnostic(requests.join('; '));
  }
});
