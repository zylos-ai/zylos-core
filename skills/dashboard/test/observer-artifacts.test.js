import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBSERVER_ARTIFACT_CATALOG,
  OBSERVER_ARTIFACTS,
  observerArtifactFor,
  observerPlatformKey,
  observerCatalogFor,
} from '../src/lib/observer-artifacts.js';

test('catalog pins every upstream v0.45.1 full-Web binary target', () => {
  assert.deepEqual(Object.keys(OBSERVER_ARTIFACT_CATALOG).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  for (const artifact of Object.values(OBSERVER_ARTIFACT_CATALOG)) {
    assert.equal(artifact.version, '0.45.1');
    assert.match(artifact.url, /\/releases\/download\/v0\.45\.1\//);
    assert.match(artifact.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(artifact.binarySha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(artifact.url, /no-web|latest/i);
  }
  assert.equal(OBSERVER_ARTIFACT_CATALOG['win32-x64'].alternatives[0].format, 'msi');
});

test('runtime selection enables exactly the three supported target hosts', () => {
  assert.deepEqual(Object.keys(OBSERVER_ARTIFACTS).sort(), ['darwin-arm64', 'linux-arm64', 'linux-x64']);
  for (const [platform, arch, target] of [
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['linux', 'x64', 'x86_64-unknown-linux-musl'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
  ]) {
    const artifact = observerArtifactFor(platform, arch);
    assert.equal(artifact, OBSERVER_ARTIFACT_CATALOG[`${platform}-${arch}`]);
    assert.equal(artifact.target, target);
  }
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'x64'], ['linux', 'ia32'], ['win32', 'arm64']]) {
    assert.equal(observerArtifactFor(platform, arch), null);
  }
  assert.equal(observerCatalogFor('win32', 'arm64'), null);
});

test('omitting platform arguments selects the running server host', () => {
  assert.equal(observerPlatformKey(), `${process.platform}-${process.arch}`);
  assert.equal(observerArtifactFor(), OBSERVER_ARTIFACTS[`${process.platform}-${process.arch}`] || null);
  assert.equal(observerCatalogFor(), OBSERVER_ARTIFACT_CATALOG[`${process.platform}-${process.arch}`] || null);
});
