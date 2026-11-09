import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observerArtifactFor } from '../src/lib/observer-artifacts.js';
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

for (const status of [500, 502, 504]) test(`HTTP ${status} falls back once through the release API and preserves pinned digests`, async (t) => {
  const { fixture, installer, calls, logs } = fallbackFixture(t, () => new Response('', { status }));
  assert.equal((await installer.install()).state, 'installed');
  assert.deepEqual(calls, [fixture.artifact.url, releaseApi, assetApi, assetStore]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`direct HTTP ${status}; API fallback download succeeded`));
  const record = JSON.parse(fs.readFileSync(installer.paths.installedManifest));
  assert.equal(record.archiveSha256, fixture.artifact.archiveSha256);
});

test('network failure preserves the cause code without disclosing the transport message', async (t) => {
  const { installer, logs } = fallbackFixture(t, () => { throw new Error('private transport diagnostic', {
    cause: Object.assign(new Error('private cause'), { code: 'ENOTFOUND' }),
  }); });
  assert.equal((await installer.install()).state, 'installed');
  assert.match(logs[0], /direct network error \(ENOTFOUND\); API fallback download succeeded/);
  assert.equal(logs[0].includes('private transport diagnostic'), false);
});

test('direct idle timeout falls back with a fresh idle timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { installer, logs } = fallbackFixture(t, ({ signal }) => {
    t.mock.timers.tick(60_001);
    signal.throwIfAborted();
  });
  assert.equal((await installer.install()).state, 'installed');
  assert.match(logs[0], /direct download timed out; API fallback download succeeded/);
});

test('partial direct stream is removed before fallback opens its archive', async (t) => {
  const { installer } = fallbackFixture(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    pull(controller) { controller.error(new Error('network interrupted')); },
  })));
  assert.equal((await installer.install()).state, 'installed');
  assert.deepEqual(fs.readdirSync(installer.paths.staging), []);
});

for (const status of [401, 403, 404, 429]) test(`direct HTTP ${status} never requests the API`, async (t) => {
  const { fixture, installer, calls } = fallbackFixture(t, () => new Response('', { status }));
  await assert.rejects(installer.install(), (error) => error.code === 'download_failed' && error.message.includes(`HTTP ${status}`));
  assert.deepEqual(calls, [fixture.artifact.url]);
});

test('API rate limit failure includes both path results and stops after one fallback', async (t) => {
  const { fixture, installer, calls, logs } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    metadata: () => new Response('rate limit', { status: 403 }),
  });
  await assert.rejects(installer.install(), (error) => error.code === 'download_failed' &&
    /direct HTTP 504; API HTTP 403/.test(error.message));
  assert.deepEqual(calls, [fixture.artifact.url, releaseApi]);
  assert.match(logs[0], /direct HTTP 504; API HTTP 403/);
  assert.deepEqual(fs.readdirSync(installer.paths.staging), []);
  assert.equal(fs.existsSync(installer.paths.installedManifest), false);
});

test('API asset transport failure includes both reasons without leaking raw errors', async (t) => {
  const { installer, calls } = fallbackFixture(t, () => { throw new Error('private direct'); }, {
    asset: () => { throw new Error('private API'); },
  });
  await assert.rejects(installer.install(), (error) => error.code === 'download_failed' &&
    /direct network error; API network error/.test(error.message) && !error.message.includes('private'));
  assert.equal(calls.length, 3);
});

test('API archive bytes must match the pinned manifest even when metadata claims a digest', async (t) => {
  const { installer } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    archive: Buffer.from('not the pinned archive'),
  });
  await assert.rejects(installer.install(), (error) => error.code === 'archive_digest_mismatch');
  assert.equal(fs.existsSync(installer.paths.installedManifest), false);
});

for (const location of [
  'https://untrusted.invalid/archive', 'http://github.com/archive',
  'https://github.com.untrusted.invalid/archive', 'https://user:password@github.com/archive',
  'https://evilgithub.com/archive',
  'https://release-assets.githubusercontent.com:444/archive',
]) test(`API redirect refuses unsafe destination ${new URL(location).hostname}`, async (t) => {
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    asset: () => new Response(null, { status: 302, headers: { location } }),
  });
  await assert.rejects(installer.install(), (error) => error.code === 'unsafe_redirect' && /direct HTTP 504; API/.test(error.message));
  assert.equal(calls.length, 3, 'unsafe destination must never be requested');
});

test('unsafe direct redirect never falls back', async (t) => {
  const { fixture, installer, calls } = fallbackFixture(t, () => new Response(null, {
    status: 302, headers: { location: 'https://untrusted.invalid/archive' },
  }));
  await assert.rejects(installer.install(), (error) => error.code === 'unsafe_redirect');
  assert.deepEqual(calls, [fixture.artifact.url]);
});

test('metadata cannot nominate an asset API outside the pinned repository', async (t) => {
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    metadata: () => Response.json({ assets: [{ name: 'zellij.tar.gz', url: 'https://api.github.com/repos/other/repo/releases/assets/123' }] }),
  });
  await assert.rejects(installer.install(), (error) => error.code === 'unsafe_redirect');
  assert.equal(calls.length, 2);
});

for (const [name, response, code] of [
  ['invalid JSON', () => new Response('{'), 'invalid_release_metadata'],
  ['missing asset', () => Response.json({ assets: [] }), 'release_asset_missing'],
]) test(`API ${name} fails without requesting an asset`, async (t) => {
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 504 }), { metadata: response });
  await assert.rejects(installer.install(), (error) => error.code === code);
  assert.equal(calls.length, 2);
});

for (const preaborted of [true, false]) test(`external cancellation ${preaborted ? 'before' : 'during'} download never falls back`, async (t) => {
  const controller = new AbortController();
  if (preaborted) controller.abort();
  const { installer, calls } = fallbackFixture(t, ({ signal }) => {
    controller.abort();
    signal.throwIfAborted();
  });
  await assert.rejects(installer.install({ signal: controller.signal }), (error) => error.code === 'download_cancelled');
  assert.equal(calls.length, preaborted ? 0 : 1);
});

test('archive size errors never trigger network fallback', async (t) => {
  const oversized = fallbackFixture(t, () => new Response('small', { headers: { 'content-length': String(128 * 1024 * 1024 + 1) } }));
  await assert.rejects(oversized.installer.install(), (error) => error.code === 'archive_too_large');
  assert.equal(oversized.calls.length, 1);
});

for (const useApi of [false, true]) test(`${useApi ? 'API' : 'direct'} progress callback errors report download_failed without retrying`, async (t) => {
  const progress = fallbackFixture(t, () => new Response(useApi ? '' : 'bytes', { status: useApi ? 504 : 200 }));
  await assert.rejects(progress.installer.install({ onProgress: () => { throw new Error('progress failed'); } }),
    (error) => error.code === 'download_failed' && /local download failure/.test(error.message));
  assert.equal(progress.calls.length, useApi ? 4 : 1);
  assert.deepEqual(fs.readdirSync(progress.installer.paths.staging), []);
  assert.equal(fs.existsSync(progress.installer.paths.installedManifest), false);
});

test('API timeout reports both paths and does not retry again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    metadata: () => { t.mock.timers.tick(60_001); throw new Error('aborted transport'); },
  });
  await assert.rejects(installer.install(), (error) => error.code === 'download_timeout' &&
    /direct HTTP 504; API download timed out/.test(error.message));
  assert.equal(calls.length, 2);
});

test('API asset HTTP failure reports both paths', async (t) => {
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 502 }), {
    asset: () => new Response('', { status: 503 }),
  });
  await assert.rejects(installer.install(), (error) => error.code === 'download_failed' &&
    /direct HTTP 502; API HTTP 503/.test(error.message));
  assert.equal(calls.length, 3);
});

test('external cancellation during API metadata stops the fallback', async (t) => {
  const controller = new AbortController();
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    metadata: () => { controller.abort(); throw new Error('cancelled transport'); },
  });
  await assert.rejects(installer.install({ signal: controller.signal }), (error) => error.code === 'download_cancelled');
  assert.equal(calls.length, 2);
});

for (const useApi of [false, true]) test(`${useApi ? 'API' : 'direct'} local archive conflict reports download_failed and cancels the response`, async (t) => {
  let cancelled = false;
  let destination;
  const response = () => {
    const stages = fs.readdirSync(installer.paths.staging);
    assert.equal(stages.length, 1);
    destination = path.join(installer.paths.staging, stages[0], 'zellij.tar.gz');
    fs.mkdirSync(destination);
    return new Response(new ReadableStream({
      start() {}, cancel() { cancelled = true; },
    }));
  };
  const { installer, calls } = fallbackFixture(t,
    () => useApi ? new Response('', { status: 504 }) : response(),
    useApi ? { asset: response } : {});
  await assert.rejects(installer.install(), (error) => {
    assert.equal(error.code, 'download_failed');
    assert.match(error.message, useApi ? /direct HTTP 504; API local download failure/ : /^local download failure$/);
    return true;
  });
  assert.equal(calls.length, useApi ? 3 : 1);
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(installer.paths.installedManifest), false);
});

test('throwing success logger preserves a verified API installation', async (t) => {
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 504 }));
  installer.logger.info = () => { throw new Error('logger unavailable'); };
  assert.equal((await installer.install()).state, 'installed');
  assert.equal((await installer.verify()).state, 'installed');
  assert.equal(calls.length, 4);
});

test('throwing failure logger preserves the download error and both path results', async (t) => {
  const { installer, calls } = fallbackFixture(t, () => new Response('', { status: 504 }), {
    asset: () => new Response('', { status: 403 }),
  });
  installer.logger.warn = () => { throw new Error('logger unavailable'); };
  await assert.rejects(installer.install(), (error) => error.code === 'download_failed' &&
    /direct HTTP 504; API HTTP 403/.test(error.message));
  assert.equal(calls.length, 3);
});

function timedResponse(t, bytes, signal, { gap = 45_000, stall = false, empty = false } = {}) {
  return { ok: true, status: 200, headers: new Headers(), body: {
    async *[Symbol.asyncIterator]() {
      const mid = Math.ceil(bytes.length / 2);
      for (const chunk of [bytes.subarray(0, mid), bytes.subarray(mid)]) {
        t.mock.timers.tick(gap);
        signal.throwIfAborted();
        yield empty ? Buffer.alloc(0) : chunk;
      }
      if (stall) {
        t.mock.timers.tick(60_001);
        signal.throwIfAborted();
      }
    },
    async cancel() {},
  } };
}

for (const stage of ['direct', 'metadata', 'asset']) {
  test(`${stage} download completes after more than a minute with continuous progress`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = makeArtifactFixture(t);
    const metadata = Buffer.from(JSON.stringify({ assets: [{ name: 'zellij.tar.gz', url: assetApi }] }));
    let reads = 0;
    const installer = installerFor(t, fixture, { logger: { info() {}, warn() {} }, fetchImpl: async (url, { signal }) => {
      if (url === fixture.artifact.url && stage !== 'direct') return new Response('', { status: 504 });
      if (url === releaseApi && stage !== 'metadata') return new Response(metadata);
      reads++;
      return timedResponse(t, stage === 'metadata' && url === releaseApi ? metadata : fixture.archive, signal);
    } });
    assert.equal((await installer.install()).state, 'installed');
    assert.ok(reads >= 1);
    assert.equal(fs.readdirSync(installer.paths.staging).length, 0);
  });

  for (const gap of [60_001, 45_000]) test(`${stage} aborts on ${gap === 60_001 ? 'first-byte' : 'mid-stream'} inactivity`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = makeArtifactFixture(t);
    const metadata = Buffer.from(JSON.stringify({ assets: [{ name: 'zellij.tar.gz', url: assetApi }] }));
    let stalledSignal;
    const installer = installerFor(t, fixture, { logger: { info() {}, warn() {} }, fetchImpl: async (url, { signal }) => {
      if (stage !== 'direct' && url === fixture.artifact.url) return new Response('', { status: 504 });
      if (stage === 'direct' && url === releaseApi) return new Response('', { status: 403 });
      if (stage === 'asset' && url === releaseApi) return new Response(metadata);
      stalledSignal = signal;
      return timedResponse(t, stage === 'metadata' ? metadata : fixture.archive, signal, { gap, stall: true });
    } });
    await assert.rejects(installer.install(), error => /download timed out/.test(error.message) &&
      error.code === (stage === 'direct' ? 'download_failed' : 'download_timeout'));
    assert.equal(stalledSignal.aborted, true);
    assert.equal(fs.existsSync(installer.paths.installedManifest), false);
    assert.equal(fs.readdirSync(installer.paths.staging).length, 0);
  });
}

test('empty response chunks cannot keep a stalled download alive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fixture, installer, logs } = fallbackFixture(t, () => new Response('', { status: 504 }));
  const originalFetch = installer.fetchImpl;
  installer.fetchImpl = async (url, options) => url === fixture.artifact.url
    ? timedResponse(t, fixture.archive, options.signal, { empty: true }) : originalFetch(url, options);
  assert.equal((await installer.install()).state, 'installed');
  assert.match(logs[0], /direct download timed out/);
});

for (const stage of ['direct', 'metadata', 'asset']) for (const redirects of [5, 6]) {
  test(`${stage} accepts five redirects and rejects a sixth with ${redirects} redirects offered`, async t => {
    const fixture = makeArtifactFixture(t);
    let requests = 0, cancelled = 0, total = 0;
    const installer = installerFor(t, fixture, { logger: { info() {}, warn() {} }, fetchImpl: async url => {
      total++;
      assert.ok(total <= 9, 'requests remain bounded');
      if (stage !== 'direct' && url === fixture.artifact.url) return new Response('', { status: 504 });
      if (stage === 'asset' && url === releaseApi) return Response.json({ assets: [{ name: 'zellij.tar.gz', url: assetApi }] });
      if (stage === 'metadata' && url === assetApi) return new Response(fixture.archive);
      requests++;
      if (requests <= redirects) return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
        status: 302, headers: { location: `https://api.github.com/redirect-${requests}` },
      });
      return stage === 'metadata' ? Response.json({ assets: [{ name: 'zellij.tar.gz', url: assetApi }] }) : new Response(fixture.archive);
    } });
    if (redirects === 5) assert.equal((await installer.install()).state, 'installed');
    else await assert.rejects(installer.install(), { code: 'unsafe_redirect' });
    assert.equal(requests, 6);
    assert.equal(cancelled, redirects);
    assert.equal(total, stage === 'direct' ? 6 : stage === 'metadata' && redirects === 5 ? 8 : stage === 'asset' ? 8 : 7);
    assert.equal(fs.existsSync(installer.paths.installedManifest), redirects === 5);
    assert.equal(fs.readdirSync(installer.paths.staging).length, 0);
  });
}

for (const stream of [false, true]) test(`network ${stream ? 'stream' : 'request'} diagnostics retain bounded codes for both routes`, async t => {
  const { fixture, installer, logs } = fallbackFixture(t, () => new Response('', { status: 504 }));
  const originalFetch = installer.fetchImpl;
  installer.fetchImpl = async (url, options) => {
    if (url === releaseApi) return originalFetch(url, options);
    const code = url === fixture.artifact.url ? 'ECONNRESET' : 'ENOTFOUND';
    const error = new Error('https://private.invalid/secret response', { cause: Object.assign(new Error('secret'), { code }) });
    if (!stream) throw error;
    return new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
  };
  await assert.rejects(installer.install(), error => error.code === 'download_failed' &&
    /direct .*ECONNRESET.*API .*ENOTFOUND/.test(error.message) && !/private|secret|https:/.test(error.message));
  assert.equal(logs.length, 1);
});

test('invalid or oversized transport codes never expose raw messages', async t => {
  const { installer, logs } = fallbackFixture(t, () => { throw Object.assign(new Error('secret'), {
    code: 'x'.repeat(65), cause: { code: 'https://private.invalid/token' },
  }); });
  assert.equal((await installer.install()).state, 'installed');
  assert.match(logs[0], /direct network error; API fallback/);
  assert.equal(logs[0].includes('secret'), false);
});

for (const outcome of ['success', 'failure', 'cancelled']) test(`download ${outcome} releases all idle timers`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = new Set();
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const timer = set(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); return clear(timer); });
  const { installer } = fallbackFixture(t, () => new Response('', { status: 503 }), {
    metadata: () => new Response('', { status: 503 }),
  });
  if (outcome === 'success') {
    const fixture = makeArtifactFixture(t);
    const good = installerFor(t, fixture);
    assert.equal((await good.install()).state, 'installed');
  } else {
    const controller = new AbortController();
    if (outcome === 'cancelled') controller.abort();
    await assert.rejects(installer.install({ signal: controller.signal }), {
      code: outcome === 'cancelled' ? 'download_cancelled' : 'download_failed',
    });
  }
  assert.equal(timers.size, 0);
});
