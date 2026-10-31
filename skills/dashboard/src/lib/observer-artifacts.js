export const OBSERVER_ZELLIJ_VERSION = '0.45.1';

// Artifact availability and product support are deliberately separate.  This
// catalog mirrors every upstream v0.45.1 full-Web binary target, while
// Observer installation is enabled only after the platform's containment and
// lifecycle adapter has passed native acceptance.
export const OBSERVER_ARTIFACT_CATALOG = Object.freeze({
  'darwin-arm64': Object.freeze({
    platform: 'darwin-arm64',
    target: 'aarch64-apple-darwin',
    version: OBSERVER_ZELLIJ_VERSION,
    url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-aarch64-apple-darwin.tar.gz',
    archiveSha256: 'c029ba4fe1927b79ad9f0cdd59155c4dff80777863c85857d4d09b88b56f9891',
    binarySha256: 'ca5f9333735bdbc59a621f1d8ed8e24798845302a28ff175d253d4793d5a4a2c',
    archiveEntry: 'zellij',
    format: 'tar.gz',
    supportState: 'validated',
  }),
  'darwin-x64': Object.freeze({
    platform: 'darwin-x64',
    target: 'x86_64-apple-darwin',
    version: OBSERVER_ZELLIJ_VERSION,
    url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-x86_64-apple-darwin.tar.gz',
    archiveSha256: '8e8bea22737d1652278c51fc5c26c7c22c9855d0ebb9634a84b8873823093114',
    binarySha256: 'e3afe876c04cb83ca3f68cb939113ec7b1abe5fb46c13727c102a64afcb4b7d4',
    archiveEntry: 'zellij',
    format: 'tar.gz',
    supportState: 'native_validation_required',
  }),
  'linux-arm64': Object.freeze({
    platform: 'linux-arm64',
    target: 'aarch64-unknown-linux-musl',
    version: OBSERVER_ZELLIJ_VERSION,
    url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-aarch64-unknown-linux-musl.tar.gz',
    archiveSha256: '05f0802afadd53f8db9514e7cae53c9ae8432fed1b35b8294aa816ee3044a16b',
    binarySha256: '2a2c0621e6f3b11ecbb05d66939a48000a2508604620aa20727a5fd61c49f451',
    archiveEntry: 'zellij',
    format: 'tar.gz',
    supportState: 'validated',
  }),
  'linux-x64': Object.freeze({
    platform: 'linux-x64',
    target: 'x86_64-unknown-linux-musl',
    version: OBSERVER_ZELLIJ_VERSION,
    url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-x86_64-unknown-linux-musl.tar.gz',
    archiveSha256: '40bcc2e03f5d5ae8e054e39f676081fe12ab70871506996ba595834c3718eefc',
    binarySha256: 'd006c521dcb475a6005d741e9dd7c5758e5a23b28dd60a5c10cebfa4876319dd',
    archiveEntry: 'zellij',
    format: 'tar.gz',
    supportState: 'validated',
  }),
  'win32-x64': Object.freeze({
    platform: 'win32-x64',
    target: 'x86_64-pc-windows-msvc',
    version: OBSERVER_ZELLIJ_VERSION,
    url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-x86_64-pc-windows-msvc.zip',
    archiveSha256: 'b854e7b223e67d0705c5f685ef50541c38a57981b13624d09c92bed419b6f80d',
    binarySha256: '7c34f38921e6884873a9922bfdd4907f4d68fd0a2dd930ce357e4c7cb23f6f42',
    archiveEntry: 'zellij.exe',
    format: 'zip',
    supportState: 'lifecycle_adapter_required',
    alternatives: Object.freeze([Object.freeze({
      format: 'msi',
      url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-x86_64-pc-windows-msvc-installer.msi',
      archiveSha256: '65081c22417c3526423991c45d5df29c071c035b44bcb53e5c7740df1441c466',
    })]),
  }),
});

export const OBSERVER_ARTIFACTS = Object.freeze(Object.fromEntries(
  Object.entries(OBSERVER_ARTIFACT_CATALOG).filter(([, artifact]) => artifact.supportState === 'validated'),
));

export function observerPlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function observerArtifactFor(platform = process.platform, arch = process.arch) {
  return OBSERVER_ARTIFACTS[observerPlatformKey(platform, arch)] || null;
}

export function observerCatalogFor(platform = process.platform, arch = process.arch) {
  return OBSERVER_ARTIFACT_CATALOG[observerPlatformKey(platform, arch)] || null;
}
