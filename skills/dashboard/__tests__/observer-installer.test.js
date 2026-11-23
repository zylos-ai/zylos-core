import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ObserverInstaller } from '../src/lib/observer-installer.js';
import { assertObserverTestIsolation } from './helpers/observer-isolation.js';

assertObserverTestIsolation();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeArtifactFixture(t, { symlink = false, platform = 'darwin-arm64' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const binaryPath = path.join(source, 'zellij');
  if (symlink) {
    fs.symlinkSync('/bin/echo', binaryPath);
  } else {
    fs.writeFileSync(binaryPath, '#!/bin/sh\nprintf "zellij 0.45.1\\n"\n', { mode: 0o755 });
  }
  const archivePath = path.join(root, 'zellij.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', source, 'zellij']);
  const archive = fs.readFileSync(archivePath);
  return {
    root,
    archive,
    artifact: {
      platform,
      version: '0.45.1',
      url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij.tar.gz',
      archiveSha256: sha256(archive),
      binarySha256: symlink ? sha256(Buffer.alloc(0)) : sha256(fs.readFileSync(binaryPath)),
      archiveEntry: 'zellij',
    },
  };
}

function installerFor(t, fixture, overrides = {}) {
  const dataDir = path.join(fixture.root, 'data');
  const licensePath = path.join(fixture.root, 'LICENSE.md');
  fs.writeFileSync(licensePath, 'MIT test notice\n');
  const fetchImpl = overrides.fetchImpl || (async () => new Response(fixture.archive, {
    status: 200,
    headers: { 'content-length': String(fixture.archive.length) },
  }));
  return new ObserverInstaller({
    dataDir,
    platform: fixture.artifact.platform.split('-')[0],
    arch: fixture.artifact.platform.split('-')[1],
    artifact: fixture.artifact,
    fetchImpl,
    licensePath,
    ...overrides,
  });
}

for (const platform of ['darwin-arm64', 'linux-x64', 'linux-arm64']) test(`${platform} installer verifies both digests, version, permissions, and bundled notice`, async (t) => {
  const fixture = makeArtifactFixture(t, { platform });
  const installer = installerFor(t, fixture);
  assert.deepEqual(await installer.verify(), { state: 'not_installed', platform });
  const installed = await installer.install();
  assert.equal(installed.state, 'installed');
  assert.equal(fs.statSync(installed.binaryPath).mode & 0o777, 0o755);
  assert.equal(fs.statSync(installer.paths.installedManifest).mode & 0o777, 0o600);
  assert.equal(fs.statSync(installer.paths.root).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(path.dirname(installed.binaryPath), 'LICENSE.zellij.md'), 'utf8'), 'MIT test notice\n');
  const manifest = JSON.parse(fs.readFileSync(installer.paths.installedManifest, 'utf8'));
  assert.equal(manifest.archiveSha256, fixture.artifact.archiveSha256);
  assert.equal(manifest.binarySha256, fixture.artifact.binarySha256);
  assert.equal((await installer.verify()).state, 'installed');
});

test('unsafe symlink archive is rejected before execution', async (t) => {
  const fixture = makeArtifactFixture(t, { symlink: true });
  const installer = installerFor(t, fixture);
  await assert.rejects(installer.install(), (error) => error?.code === 'unsafe_archive');
  assert.equal(fs.existsSync(installer.paths.installedManifest), false);
});

test('uninstall refuses a manifest that broadens the owned path', async (t) => {
  const fixture = makeArtifactFixture(t);
  const installer = installerFor(t, fixture);
  await installer.install();
  const manifest = JSON.parse(fs.readFileSync(installer.paths.installedManifest, 'utf8'));
  manifest.binary = '../unrelated/keep';
  fs.writeFileSync(installer.paths.installedManifest, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(installer.removeInstalledArtifacts(), (error) => error?.code === 'unsafe_removal');
});

const releaseApi = 'https://api.github.com/repos/zellij-org/zellij/releases/tags/v0.45.1';
const assetApi = 'https://api.github.com/repos/zellij-org/zellij/releases/assets/123';
const assetStore = 'https://release-assets.githubusercontent.com/pinned-archive';

function fallbackFixture(t, direct, overrides = {}) {
  const fixture = makeArtifactFixture(t);
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    if (url === fixture.artifact.url) return direct(options);
    if (url === releaseApi) {
      assert.equal(options.headers.Accept, 'application/vnd.github+json');
      return overrides.metadata?.(options) || Response.json({ assets: [
        { name: 'other.tar.gz', url: 'https://untrusted.invalid/other' },
        { name: 'zellij.tar.gz', url: assetApi, digest: 'sha256:untrusted' },
      ] });
    }
    if (url === assetApi) {
      assert.equal(options.headers.Accept, 'application/octet-stream');
      return overrides.asset?.(options) || new Response(null, { status: 302, headers: { location: assetStore } });
    }
    assert.equal(url, assetStore);
    return new Response(overrides.archive || fixture.archive);
  };
  const installer = installerFor(t, fixture, {
    fetchImpl, logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });
  return { fixture, installer, calls, logs };
}

test('API archive bytes must match the pinned manifest even when metadata claims a digest', async (t) => {
  const { installer } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    archive: Buffer.from('not the pinned archive'),
  });
  await assert.rejects(installer.install(), (error) => error.code === 'archive_digest_mismatch');
  assert.equal(fs.existsSync(installer.paths.installedManifest), false);
});

// Local archive fixture and injected fetch only. Run when install cleanup/error
// ordering changes; unrelated network/releases need not run. Official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; fixture cleanup owns all files.
