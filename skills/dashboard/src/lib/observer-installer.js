import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { observerArtifactFor, observerCatalogFor, observerPlatformKey } from './observer-artifacts.js';
import { observerPaths } from './observer-paths.js';

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
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

async function downloadArchive(url, destination, { fetchImpl, signal, onProgress }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('download_timeout')), DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let handle;
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new ObserverInstallError('download_failed', `Artifact download returned HTTP ${response.status}`);
    }
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' ||
          !['github.com', 'release-assets.githubusercontent.com'].includes(finalUrl.hostname)) {
        throw new ObserverInstallError('unsafe_redirect', 'Artifact download redirected outside the pinned release hosts');
      }
    }
    const lengthHeader = response.headers.get('content-length');
    const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
      throw new ObserverInstallError('archive_too_large', 'Artifact archive exceeds the size limit');
    }
    handle = await fs.promises.open(destination, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
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
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    if (error instanceof ObserverInstallError) throw error;
    const code = controller.signal.aborted ? 'download_timeout' : 'download_failed';
    throw new ObserverInstallError(code, `Artifact download failed: ${error.message}`, error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    try { await handle?.close(); } catch {}
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
    exec = execFileAsync,
    licensePath = path.resolve(new URL('../../assets/third-party/ZELLIJ-LICENSE.md', import.meta.url).pathname),
  }) {
    this.paths = observerPaths(dataDir);
    this.platformKey = observerPlatformKey(platform, arch);
    this.artifact = artifact;
    this.catalogArtifact = observerCatalogFor(platform, arch);
    this.fetchImpl = fetchImpl;
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
    const nonce = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
    const stageRoot = path.join(this.paths.staging, nonce);
    const archivePath = path.join(stageRoot, 'zellij.tar.gz');
    const extractionPath = path.join(stageRoot, 'extract');
    let publishDirectory = null;
    await ensurePrivateDirectory(stageRoot);
    try {
      const download = await downloadArchive(this.artifact.url, archivePath, {
        fetchImpl: this.fetchImpl, signal, onProgress,
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
      publishDirectory = path.join(this.paths.artifacts, `.publish-${nonce}`);
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
        await fs.promises.rm(publishDirectory, { recursive: true, force: true });
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
    } finally {
      await fs.promises.rm(stageRoot, { recursive: true, force: true });
      if (publishDirectory) await fs.promises.rm(publishDirectory, { recursive: true, force: true });
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
    await fs.promises.rm(expectedDirectory, { recursive: true, force: true });
    await fs.promises.unlink(this.paths.installedManifest);
    return { state: 'not_installed', platform: this.platformKey };
  }
}
