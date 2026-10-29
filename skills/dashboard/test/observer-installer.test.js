import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observerArtifactFor } from '../src/lib/observer-artifacts.js';
import { ObserverInstaller } from '../src/lib/observer-installer.js';

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
      url: 'https://example.invalid/zellij.tar.gz',
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

for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
  test(`${platform}-${arch} installer selects its pinned catalog artifact without injection`, async (t) => {
    const fixture = makeArtifactFixture(t);
    const installer = new ObserverInstaller({
      dataDir: path.join(fixture.root, 'platform-selection'), platform, arch,
    });
    assert.equal(installer.artifact, observerArtifactFor(platform, arch));
    assert.equal(installer.artifact.platform, `${platform}-${arch}`);
    assert.deepEqual(await installer.verify(), { state: 'not_installed', platform: `${platform}-${arch}` });
  });
}

test('installer defaults resolve the running server artifact without an override', (t) => {
  const fixture = makeArtifactFixture(t);
  const installer = new ObserverInstaller({ dataDir: path.join(fixture.root, 'host-default') });
  assert.equal(installer.platformKey, `${process.platform}-${process.arch}`);
  assert.equal(installer.artifact, observerArtifactFor());
});

test('archive and extracted-binary digest failures do not publish installation state', async (t) => {
  const fixture = makeArtifactFixture(t);
  const badArchive = installerFor(t, fixture, {
    artifact: { ...fixture.artifact, archiveSha256: '0'.repeat(64) },
  });
  await assert.rejects(badArchive.install(), (error) => error?.code === 'archive_digest_mismatch');
  assert.equal(fs.existsSync(badArchive.paths.installedManifest), false);

  const badBinary = installerFor(t, fixture, {
    artifact: { ...fixture.artifact, binarySha256: '1'.repeat(64) },
  });
  await assert.rejects(badBinary.install(), (error) => error?.code === 'binary_digest_mismatch');
  assert.equal(fs.existsSync(badBinary.paths.installedManifest), false);
});

test('unsafe symlink archive is rejected before execution', async (t) => {
  const fixture = makeArtifactFixture(t, { symlink: true });
  const installer = installerFor(t, fixture);
  await assert.rejects(installer.install(), (error) => error?.code === 'unsafe_archive');
  assert.equal(fs.existsSync(installer.paths.installedManifest), false);
});

test('unsupported platforms never attempt a download', async (t) => {
  const fixture = makeArtifactFixture(t);
  let fetched = false;
  const installer = new ObserverInstaller({
    dataDir: path.join(fixture.root, 'unsupported'),
    platform: 'win32',
    arch: 'x64',
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  assert.deepEqual(await installer.verify(), {
    state: 'unsupported',
    platform: 'win32-x64',
    artifactAvailable: true,
    version: '0.45.1',
    supportState: 'lifecycle_adapter_required',
  });
  await assert.rejects(installer.install(), (error) => error?.code === 'unsupported_platform');
  assert.equal(fetched, false);
});

test('failed replacement preserves an existing verified artifact', async (t) => {
  const fixture = makeArtifactFixture(t);
  const installer = installerFor(t, fixture);
  const installed = await installer.install();
  const before = fs.readFileSync(installed.binaryPath);
  const replacement = installerFor(t, fixture, {
    artifact: { ...fixture.artifact, version: '0.45.2', archiveSha256: 'f'.repeat(64) },
  });
  await assert.rejects(replacement.install(), (error) => error?.code === 'archive_digest_mismatch');
  assert.deepEqual(fs.readFileSync(installed.binaryPath), before);
});

test('uninstall removes only the exact manifest-owned directory, even after binary tampering', async (t) => {
  const fixture = makeArtifactFixture(t);
  const installer = installerFor(t, fixture);
  const installed = await installer.install();
  const sentinel = path.join(installer.paths.artifacts, 'unrelated');
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'sentinel');
  fs.appendFileSync(installed.binaryPath, 'tampered');
  assert.equal((await installer.verify()).reason, 'artifact_verification_failed');
  const removed = await installer.removeInstalledArtifacts();
  assert.equal(removed.state, 'not_installed');
  assert.equal(fs.existsSync(path.dirname(installed.binaryPath)), false);
  assert.equal(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8'), 'sentinel');
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

test('retry adopts an interrupted owned publication and cleans only its staging directories', async (t) => {
  const fixture = makeArtifactFixture(t);
  const installer = installerFor(t, fixture);
  let checks = 0;
  await assert.rejects(
    installer.install({ isCurrent: () => ++checks < 3 }),
    (error) => error?.code === 'operation_obsolete',
  );
  const artifactDirectory = path.join(
    installer.paths.artifacts,
    `${fixture.artifact.version}-${fixture.artifact.platform}`,
  );
  assert.equal(fs.existsSync(path.join(artifactDirectory, '.publication.json')), true);
  assert.deepEqual(fs.readdirSync(installer.paths.artifacts).filter((name) => name.startsWith('.publish-')), []);
  assert.deepEqual(fs.readdirSync(installer.paths.staging), []);

  const installed = await installer.install();
  assert.equal(installed.state, 'installed');
  assert.equal(fs.existsSync(path.join(artifactDirectory, '.publication.json')), false);
  assert.deepEqual(fs.readdirSync(installer.paths.artifacts).filter((name) => name.startsWith('.publish-')), []);
});

test('verify and uninstall reject a symlinked managed artifacts parent without touching its target', async (t) => {
  const fixture = makeArtifactFixture(t);
  const installer = installerFor(t, fixture);
  await installer.install();
  const external = path.join(fixture.root, 'external-artifacts');
  fs.renameSync(installer.paths.artifacts, external);
  fs.symlinkSync(external, installer.paths.artifacts);
  const sentinel = path.join(external, `${fixture.artifact.version}-${fixture.artifact.platform}`, 'zellij');

  assert.equal((await installer.verify()).state, 'failed');
  await assert.rejects(installer.removeInstalledArtifacts(), (error) => error?.code === 'unsafe_removal');
  assert.equal(fs.existsSync(sentinel), true);
});

test('uninstall retries after artifact removal interrupted before manifest deletion', async (t) => {
  const fixture = makeArtifactFixture(t);
  const installer = installerFor(t, fixture);
  const installed = await installer.install();
  const sentinel = path.join(installer.paths.artifacts, 'unrelated');
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'sentinel');
  fs.rmSync(path.dirname(installed.binaryPath), { recursive: true });
  assert.equal(fs.existsSync(installer.paths.installedManifest), true);
  assert.equal((await installer.removeInstalledArtifacts()).state, 'not_installed');
  assert.equal(fs.existsSync(installer.paths.installedManifest), false);
  assert.equal(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8'), 'sentinel');
  assert.equal((await installer.removeInstalledArtifacts()).state, 'not_installed');
});

test('history installation inspection never reads binary contents or executes it; full verification still does', async t => {
  const fixture = makeArtifactFixture(t);
  const installer = installerFor(t, fixture);
  const installed = await installer.install();
  installer.exec = async () => { throw new Error('must not execute for history'); };
  const readFile = fs.promises.readFile;
  const createReadStream = fs.createReadStream;
  fs.promises.readFile = async (file, ...args) => {
    assert.notEqual(String(file), installed.binaryPath, 'history read binary contents');
    return readFile(file, ...args);
  };
  fs.createReadStream = (file, ...args) => {
    assert.notEqual(String(file), installed.binaryPath, 'history hashed binary');
    return createReadStream(file, ...args);
  };
  try { assert.equal((await installer.inspectInstallation()).state, 'installed'); }
  finally { fs.promises.readFile = readFile; fs.createReadStream = createReadStream; }
  assert.equal((await installer.verify()).state, 'failed');
  fs.unlinkSync(installer.paths.installedManifest);
  assert.equal((await installer.inspectInstallation()).state, 'not_installed');
});
