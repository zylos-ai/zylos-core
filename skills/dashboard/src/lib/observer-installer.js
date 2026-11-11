import { removeOwnedTree } from '../../../comm-bridge/scripts/remove-owned-tree.js';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { observerArtifactFor, observerCatalogFor, observerPlatformKey } from './observer-artifacts.js';
import { observerPaths } from './observer-paths.js';

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const RELEASE_API_ROOT = 'https://api.github.com/repos/zellij-org/zellij/releases';
const RELEASE_HOSTS = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com']);
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT = 64 * 1024;

export class ObserverInstallError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ObserverInstallError';
    this.code = code;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensurePrivateDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ObserverInstallError('unsafe_managed_root', `Observer managed root is not a private directory: ${directory}`);
  }
  await fs.promises.chmod(directory, 0o700);
}

async function assertPrivateDirectory(directory, code = 'unsafe_managed_root') {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ObserverInstallError(code, `Observer managed path is not a private directory: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ObserverInstallError(code, `Observer managed path has unsafe permissions: ${directory}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    await fs.promises.chmod(filePath, 0o600);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.promises.unlink(temporaryPath); } catch {}
    throw error;
  }
}

function downloadFailure(code, message, retryable = false) {
  const error = new ObserverInstallError(code, message);
  error.retryable = retryable;
  return error;
}

function networkReason(error) {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    for (const value of [error.code, error.errno]) {
      const code = String(value ?? '');
      if (/^[A-Za-z0-9_-]{1,64}$/.test(code)) return ` (${code})`;
    }
  }
  return '';
}

function assertReleaseUrl(value) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port ||
      !RELEASE_HOSTS.has(url.hostname)) {
    throw new ObserverInstallError('unsafe_redirect', 'Artifact download redirected outside the pinned release hosts');
  }
  return url;
}

async function releaseRequest(url, { fetchImpl, signal, accept, onActivity }) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    assertReleaseUrl(url);
    let response;
    try {
      onActivity();
      response = await fetchImpl(url, {
        redirect: 'manual', signal, ...(accept ? { headers: { Accept: accept } } : {}),
      });
    } catch (error) {
      throw downloadFailure('download_failed', `network error${networkReason(error)}`, true);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new ObserverInstallError('unsafe_redirect', 'Release redirect has no location');
      try { url = new URL(location, url).href; } catch {
        throw new ObserverInstallError('unsafe_redirect', 'Release redirect has an invalid location');
      }
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw downloadFailure('download_failed', `HTTP ${response.status}`, response.status >= 500 && response.status <= 599);
    }
    return response;
  }
  throw new ObserverInstallError('unsafe_redirect', 'Release download exceeded the redirect limit');
}

async function* responseChunks(response, onActivity) {
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      let next;
      try { next = await iterator.next(); } catch (error) {
        throw downloadFailure('download_failed', `network error while reading response${networkReason(error)}`, true);
      }
      if (next.done) return;
      if (next.value.byteLength > 0) onActivity();
      yield Buffer.from(next.value);
    }
  } finally {
    try { await iterator.return?.(); } catch {}
  }
}

async function apiAssetResponse(artifact, options) {
  const response = await releaseRequest(`${RELEASE_API_ROOT}/tags/v${encodeURIComponent(artifact.version)}`, {
    ...options, accept: 'application/vnd.github+json',
  });
  const chunks = [];
  for await (const chunk of responseChunks(response, options.onActivity)) {
    chunks.push(chunk);
  }
  let release;
  try { release = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new ObserverInstallError('invalid_release_metadata', 'Release metadata is not valid JSON');
  }
  const name = new URL(artifact.url).pathname.split('/').at(-1);
  const asset = Array.isArray(release?.assets) && release.assets.find((entry) => entry?.name === name);
  if (!asset) throw new ObserverInstallError('release_asset_missing', 'Pinned archive is absent from the release');
  if (typeof asset.url !== 'string' || !/^https:\/\/api\.github\.com\/repos\/zellij-org\/zellij\/releases\/assets\/[0-9]+$/.test(asset.url)) {
    throw new ObserverInstallError('unsafe_redirect', 'Release asset API address is outside the pinned repository');
  }
  return releaseRequest(asset.url, { ...options, accept: 'application/octet-stream' });
}

async function downloadAttempt(artifact, destination, { fetchImpl, signal, onProgress }, useApi) {
  const controller = new AbortController();
  let timeout;
  const onActivity = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(new Error('download_timeout')), DOWNLOAD_IDLE_TIMEOUT_MS);
    timeout.unref?.();
  };
  onActivity();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let handle;
  let created = false;
  let response;
  try {
    controller.signal.throwIfAborted();
    const options = { fetchImpl, signal: controller.signal, onActivity };
    response = useApi ? await apiAssetResponse(artifact, options)
      : await releaseRequest(artifact.url, options);
    const lengthHeader = response.headers.get('content-length');
    const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
      await response.body.cancel();
      throw new ObserverInstallError('archive_too_large', 'Artifact archive exceeds the size limit');
    }
    handle = await fs.promises.open(destination, 'wx', 0o600);
    created = true;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const chunk of responseChunks(response, onActivity)) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        throw new ObserverInstallError('archive_too_large', 'Artifact archive exceeds the size limit');
      }
      hash.update(chunk);
      await handle.write(chunk);
      onProgress?.({ phase: 'download', bytes, total: Number.isFinite(declaredLength) ? declaredLength : null });
    }
    await handle.sync();
    await handle.close();
    handle = null;
    controller.signal.throwIfAborted();
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    try { await handle?.close(); } catch {}
    handle = null;
    if (created) {
      try { await fs.promises.unlink(destination); } catch (cleanupError) { error = cleanupError; }
    }
    if (signal?.aborted) throw downloadFailure('download_cancelled', 'download cancelled');
    if (controller.signal.aborted) throw downloadFailure('download_timeout', 'download timed out', true);
    if (error instanceof ObserverInstallError) throw error;
    throw downloadFailure('download_failed', 'local download failure');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    try { await response?.body?.cancel(); } catch {}
    try { await handle?.close(); } catch {}
  }
}

async function downloadArchive(artifact, destination, options) {
  let directError;
  try {
    return await downloadAttempt(artifact, destination, options, false);
  } catch (error) {
    if (!error.retryable || options.signal?.aborted) throw error;
    directError = error;
  }
  try {
    const download = await downloadAttempt(artifact, destination, options, true);
    try { options.logger.info(`Observer artifact download: direct ${directError.message}; API fallback download succeeded`); } catch {}
    return download;
  } catch (error) {
    const message = `Artifact download failed: direct ${directError.message}; API ${error instanceof ObserverInstallError ? error.message : 'local download failure'}`;
    try { options.logger.warn(message); } catch {}
    throw new ObserverInstallError(error.code || 'download_failed', message, error);
  }
}

async function inspectAndExtract(archivePath, extractionPath, expectedEntry, exec = execFileAsync) {
  const commandOptions = { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT };
  let names;
  let verbose;
  try {
    names = await exec('tar', ['-tzf', archivePath], commandOptions);
    verbose = await exec('tar', ['-tvzf', archivePath], commandOptions);
  } catch (error) {
    throw new ObserverInstallError('invalid_archive', `Unable to inspect artifact archive: ${error.message}`, error);
  }
  const entries = names.stdout.trim().split('\n').filter(Boolean);
  const detailLines = verbose.stdout.trim().split('\n').filter(Boolean);
  if (entries.length !== 1 || entries[0] !== expectedEntry ||
      detailLines.length !== 1 || !detailLines[0].startsWith('-')) {
    throw new ObserverInstallError('unsafe_archive', 'Artifact archive must contain exactly one regular zellij entry');
  }
  await ensurePrivateDirectory(extractionPath);
  try {
    await exec('tar', ['-xzf', archivePath, '-C', extractionPath, '--', expectedEntry], commandOptions);
  } catch (error) {
    throw new ObserverInstallError('invalid_archive', `Unable to extract artifact archive: ${error.message}`, error);
  }
  const extractedPath = path.join(extractionPath, expectedEntry);
  const stat = await fs.promises.lstat(extractedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ObserverInstallError('unsafe_archive', 'Extracted zellij entry is not an owned regular file');
  }
  return extractedPath;
}

function installedRecord(artifact, artifactDirectory) {
  return {
    schema: 1,
    platform: artifact.platform,
    version: artifact.version,
    archiveSha256: artifact.archiveSha256,
    binarySha256: artifact.binarySha256,
    binary: path.relative(path.dirname(artifactDirectory), path.join(artifactDirectory, artifact.archiveEntry)),
  };
}

function publicationRecord(artifact) {
  return {
    schema: 1,
    platform: artifact.platform,
    version: artifact.version,
    archiveSha256: artifact.archiveSha256,
    binarySha256: artifact.binarySha256,
    archiveEntry: artifact.archiveEntry,
  };
}

export class ObserverInstaller {
  constructor({
    dataDir,
    platform = process.platform,
    arch = process.arch,
    artifact = observerArtifactFor(platform, arch),
    fetchImpl = globalThis.fetch,
    logger = console,
    exec = execFileAsync,
    licensePath = path.resolve(new URL('../../assets/third-party/ZELLIJ-LICENSE.md', import.meta.url).pathname),
  }) {
    this.paths = observerPaths(dataDir);
    this.platformKey = observerPlatformKey(platform, arch);
    this.artifact = artifact;
    this.catalogArtifact = observerCatalogFor(platform, arch);
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.exec = exec;
    this.licensePath = licensePath;
  }

  async prepareRoots() {
    for (const directory of [
      this.paths.root, this.paths.artifacts, this.paths.staging, this.paths.runtime,
      this.paths.config, this.paths.cache, this.paths.data, this.paths.logs, this.paths.control,
    ]) {
      await ensurePrivateDirectory(directory);
    }
  }

  async assertArtifactChain(artifactDirectory) {
    await assertPrivateDirectory(this.paths.root);
    await assertPrivateDirectory(this.paths.artifacts);
    await assertPrivateDirectory(artifactDirectory, 'unsafe_artifact_path');
  }

  async verifyIncompletePublication(artifactDirectory) {
    try {
      await this.assertArtifactChain(artifactDirectory);
      const markerPath = path.join(artifactDirectory, '.publication.json');
      const markerStat = await fs.promises.lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) return false;
      const marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'));
      const expected = publicationRecord(this.artifact);
      if (Object.keys(expected).some((key) => marker[key] !== expected[key])) return false;
      const binaryPath = path.join(artifactDirectory, this.artifact.archiveEntry);
      const binaryStat = await fs.promises.lstat(binaryPath);
      if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || binaryStat.nlink !== 1) return false;
      if (await sha256File(binaryPath) !== this.artifact.binarySha256) return false;
      const licenseStat = await fs.promises.lstat(path.join(artifactDirectory, 'LICENSE.zellij.md'));
      return licenseStat.isFile() && !licenseStat.isSymbolicLink() && licenseStat.nlink === 1;
    } catch {
      return false;
    }
  }

  // Read-only history checks installation metadata; it never executes the artifact.
  async inspectInstallation() {
    if (!this.artifact) return {
      state: 'unsupported',
      platform: this.platformKey,
      artifactAvailable: Boolean(this.catalogArtifact),
      version: this.catalogArtifact?.version || null,
      supportState: this.catalogArtifact?.supportState || 'no_official_artifact',
    };
    try {
      await assertPrivateDirectory(this.paths.root);
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'not_installed', platform: this.platformKey };
      return { state: 'failed', platform: this.platformKey, reason: 'unsafe_managed_root' };
    }
    let record;
    try {
      const manifestStat = await fs.promises.lstat(this.paths.installedManifest);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('unsafe manifest');
      record = JSON.parse(await fs.promises.readFile(this.paths.installedManifest, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'not_installed', platform: this.platformKey };
      return { state: 'failed', platform: this.platformKey, reason: 'invalid_manifest' };
    }
    const artifactDirectory = path.join(this.paths.artifacts, `${this.artifact.version}-${this.artifact.platform}`);
    const expected = installedRecord(this.artifact, artifactDirectory);
    if (Object.keys(expected).some((key) => record[key] !== expected[key])) {
      return { state: 'failed', platform: this.platformKey, reason: 'manifest_mismatch' };
    }
    const binaryPath = path.join(this.paths.artifacts, record.binary);
    try {
      await this.assertArtifactChain(artifactDirectory);
      const stat = await fs.promises.lstat(binaryPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe binary');
      return { state: 'installed', platform: this.platformKey, version: this.artifact.version, binaryPath };
    } catch {
      return { state: 'failed', platform: this.platformKey, reason: 'artifact_verification_failed' };
    }
  }

  async verify() {
    const installation = await this.inspectInstallation();
    if (installation.state !== 'installed') return installation;
    const { binaryPath } = installation;
    try {
      if (await sha256File(binaryPath) !== this.artifact.binarySha256) throw new Error('digest mismatch');
      const result = await this.exec(binaryPath, ['--version'], {
        encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT,
      });
      if (result.stdout.trim() !== `zellij ${this.artifact.version}`) throw new Error('version mismatch');
      return installation;
    } catch {
      return { state: 'failed', platform: this.platformKey, reason: 'artifact_verification_failed' };
    }
  }

  async install({ signal, onProgress, isCurrent = () => true } = {}) {
    if (!this.artifact) throw new ObserverInstallError('unsupported_platform', `Unsupported Observer platform: ${this.platformKey}`);
    await this.prepareRoots();
    const current = await this.verify();
    if (current.state === 'installed') return current;
    const stagingRoot = await fs.promises.realpath(this.paths.staging);
    const artifactsRoot = await fs.promises.realpath(this.paths.artifacts);
    const nonce = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
    const stageRoot = path.join(stagingRoot, nonce);
    const archivePath = path.join(stageRoot, 'zellij.tar.gz');
    const extractionPath = path.join(stageRoot, 'extract');
    let publishDirectory = null, operationFailed = false, operationError;
    await ensurePrivateDirectory(stageRoot);
    try {
      const download = await downloadArchive(this.artifact, archivePath, {
        fetchImpl: this.fetchImpl, signal, onProgress, logger: this.logger,
      });
      if (download.sha256 !== this.artifact.archiveSha256) {
        throw new ObserverInstallError('archive_digest_mismatch', 'Artifact archive digest did not match the pinned manifest');
      }
      const binaryPath = await inspectAndExtract(
        archivePath, extractionPath, this.artifact.archiveEntry, this.exec,
      );
      if (await sha256File(binaryPath) !== this.artifact.binarySha256) {
        throw new ObserverInstallError('binary_digest_mismatch', 'Extracted binary digest did not match the pinned manifest');
      }
      await fs.promises.chmod(binaryPath, 0o755);
      const version = await this.exec(binaryPath, ['--version'], {
        encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT,
      });
      if (version.stdout.trim() !== `zellij ${this.artifact.version}`) {
        throw new ObserverInstallError('version_mismatch', 'Extracted binary version did not match the pinned manifest');
      }
      if (!isCurrent()) throw new ObserverInstallError('operation_obsolete', 'Observer install was superseded');

      const artifactDirectory = path.join(this.paths.artifacts, `${this.artifact.version}-${this.artifact.platform}`);
      publishDirectory = path.join(artifactsRoot, `.publish-${nonce}`);
      await fs.promises.rename(extractionPath, publishDirectory);
      const licenseDestination = path.join(publishDirectory, 'LICENSE.zellij.md');
      await fs.promises.copyFile(this.licensePath, licenseDestination, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(licenseDestination, 0o600);
      await writeJsonAtomic(path.join(publishDirectory, '.publication.json'), publicationRecord(this.artifact));
      if (!isCurrent()) throw new ObserverInstallError('operation_obsolete', 'Observer install was superseded');

      try {
        await fs.promises.rename(publishDirectory, artifactDirectory);
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
        const verified = await this.verify();
        if (verified.state !== 'installed' && !await this.verifyIncompletePublication(artifactDirectory)) {
          throw new ObserverInstallError('artifact_conflict', 'Existing managed artifact failed verification', error);
        }
        removeOwnedTree(artifactsRoot, publishDirectory);
        publishDirectory = null;
        if (verified.state === 'installed') return verified;
      }
      if (!isCurrent()) throw new ObserverInstallError('operation_obsolete', 'Observer install was superseded');
      await writeJsonAtomic(this.paths.installedManifest, installedRecord(this.artifact, artifactDirectory));
      const installed = await this.verify();
      if (installed.state !== 'installed') {
        throw new ObserverInstallError('publish_verification_failed', 'Published Observer artifact failed verification');
      }
      await fs.promises.unlink(path.join(artifactDirectory, '.publication.json'));
      onProgress?.({ phase: 'complete', bytes: download.bytes, total: download.bytes });
      return installed;
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      const cleanupErrors = [];
      for (const [root, target] of [[stagingRoot, stageRoot], [artifactsRoot, publishDirectory]]) {
        if (!target) continue;
        try { removeOwnedTree(root, target); } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length) {
        if (!operationFailed) throw new AggregateError(cleanupErrors, 'Observer installation cleanup failed');
        if (operationError && typeof operationError === 'object') {
          try { operationError.cleanupErrors = cleanupErrors; } catch { /* Preserve an immutable primary error. */ }
        }
      }
    }
  }

  async removeInstalledArtifacts() {
    if (!this.artifact) return { state: 'unsupported', platform: this.platformKey };
    try {
      await assertPrivateDirectory(this.paths.root);
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'not_installed', platform: this.platformKey };
      throw new ObserverInstallError('unsafe_removal', 'Observer managed root is not safe to inspect', error);
    }
    let record;
    try {
      const manifestStat = await fs.promises.lstat(this.paths.installedManifest);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('unsafe manifest');
      record = JSON.parse(await fs.promises.readFile(this.paths.installedManifest, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'not_installed', platform: this.platformKey };
      throw new ObserverInstallError('unsafe_removal', 'Observer install manifest is not safe to remove', error);
    }
    const expectedDirectory = path.join(this.paths.artifacts, `${this.artifact.version}-${this.artifact.platform}`);
    const expected = installedRecord(this.artifact, expectedDirectory);
    if (Object.keys(expected).some((key) => record[key] !== expected[key])) {
      throw new ObserverInstallError('unsafe_removal', 'Observer manifest did not resolve to the managed artifact directory');
    }
    try {
      await assertPrivateDirectory(this.paths.root);
      await assertPrivateDirectory(this.paths.artifacts);
      try {
        await assertPrivateDirectory(expectedDirectory, 'unsafe_artifact_path');
      } catch (error) {
        // A prior removal may have completed before manifest unlink failed.
        // Only the exact leaf may be absent; parents must still be safe.
        if (error?.code !== 'ENOENT') throw error;
      }
    } catch (error) {
      throw new ObserverInstallError('unsafe_removal', 'Observer artifact parent chain is not safe to remove', error);
    }
    const artifactsRoot = await fs.promises.realpath(this.paths.artifacts);
    removeOwnedTree(artifactsRoot, path.join(artifactsRoot, path.basename(expectedDirectory)));
    await fs.promises.unlink(this.paths.installedManifest);
    return { state: 'not_installed', platform: this.platformKey };
  }
}
