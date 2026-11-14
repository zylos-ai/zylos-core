/**
 * Download utilities for component installation and upgrades.
 * Supports GitHub archive tarballs and local paths. No git dependency.
 */

import fs from 'node:fs';
import { removeOwnedTree } from '../../skills/comm-bridge/scripts/remove-owned-tree.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import zlib from 'node:zlib';
import { getGitHubToken, sanitizeError, withRateLimitRetrySync } from './github.js';
import { githubUrl, getUpstreamSnapshot } from './upstreams.js';
import { githubRequestSync } from './github-http.js';
import { copyTree } from './fs-utils.js';
import { parseSkillMd } from './skill.js';

function getWritableTmpBase() {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(fs.realpathSync(base), 'zylos-download-probe-'));
    removeOwnedTree(path.dirname(probe), probe);
  } catch {
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  return fs.realpathSync(base);
}

function createDownloadTmpDir() {
  const base = getWritableTmpBase();
  return fs.mkdtempSync(path.join(base, 'zylos-download-'));
}

/**
 * Download a tarball from a URL using curl.
 * Tries the public endpoint first (works for public repos without auth),
 * then falls back to the authenticated GitHub API if a token is available.
 * This avoids 403 errors when a token lacks org access for public repos.
 * Retries with backoff on GitHub rate limiting.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} ref - Git ref (tag name or branch name)
 * @param {'tag'|'branch'} refType - Whether the ref is a tag or branch
 * @param {string} tarballPath - Destination file path for the tarball
 */
function curlDownload(repo, ref, refType, tarballPath) {
  const snapshot = getUpstreamSnapshot();
  withRateLimitRetrySync(
    () => curlDownloadOnce(repo, ref, refType, tarballPath, snapshot),
    `${repo}@${ref}`
  );
}

function curlDownloadOnce(repo, ref, refType, tarballPath, snapshot) {
  // 1. Try public endpoint first (no auth needed for public repos)
  const publicUrl = githubUrl('archive', repo, { ref, refType }, snapshot);
  let publicError;
  try {
    githubRequestSync(publicUrl, { output: tarballPath, timeout: 60000, snapshot });
    return;
  } catch (err) {
    // Public download failed — repo may be private, try with auth
    publicError = err;
  }

  // 2. Fall back to authenticated GitHub API (for private repos)
  const token = getGitHubToken();
  if (!token) {
    // No token available — surface the original public error; retry semantics
    // belong exclusively to the outer withRateLimitRetrySync loop (#705)
    throw publicError;
  }

  const apiUrl = githubUrl('tarball', repo, { ref }, snapshot);
  githubRequestSync(apiUrl, { token, output: tarballPath, timeout: 60000, snapshot });
}

/** The release tag a version is downloaded from: "1.0.0" and "v1.0.0" are both tag "v1.0.0". */
export function releaseTag(version) {
  return version.startsWith('v') ? version : `v${version}`;
}

// A GitHub archive, like any `git archive` tarball, starts with a pax global header whose `comment` record is the full
// id of the commit it was made from. The header sits in the first few hundred bytes, so only the start is inflated.
const ARCHIVE_HEAD_BYTES = 64 * 1024;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The commit a .tar.gz archive was made from, read from its pax global header; null when the archive does not say
 * (made by plain `tar`, or unreadable). Never guessed from names or other files.
 *
 * @param {string} tarballPath
 * @returns {string|null}
 */
export function archiveCommit(tarballPath) {
  let fd;
  try {
    fd = fs.openSync(tarballPath, 'r');
    const head = Buffer.alloc(ARCHIVE_HEAD_BYTES);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const tar = zlib.gunzipSync(head.subarray(0, read), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return paxCommit(tar);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function paxCommit(tar) {
  // ustar header: type flag at 156 ('g' = pax global header), octal body size at 124..136; the body follows at 512.
  if (tar.length < 512 || tar[156] !== 0x67) return null;
  const size = Number.parseInt(tar.subarray(124, 136).toString('latin1').replace(/\0[\s\S]*$/, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size <= 0 || 512 + size > tar.length) return null;
  const body = tar.subarray(512, 512 + size);
  // Records are "<byte length> <key>=<value>\n".
  for (let at = 0; at < body.length;) {
    const space = body.indexOf(0x20, at);
    const length = Number(body.subarray(at, space).toString('latin1'));
    if (space < 0 || !Number.isSafeInteger(length) || length <= space - at + 1 || at + length > body.length) return null;
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0 && record.slice(0, equals) === 'comment') {
      const commit = record.slice(equals + 1).trim().toLowerCase();
      return COMMIT_ID.test(commit) ? commit : null;
    }
    at += length;
  }
  return null;
}

/**
 * Download a GitHub archive tarball and extract it.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} version - Version tag (e.g. "1.0.0", will be prefixed with "v")
 * @param {string} destDir - Destination directory to extract into
 * @returns {{ success: boolean, extractedDir: string, ref?: string, refType?: 'tag', commit?: string|null, error?: string }}
 *   On success, `ref` is the tag downloaded and `commit` the commit the archive says it was made from.
 */
export function downloadArchive(repo, version, destDir) {
  const tag = releaseTag(version);
  let tmpDir;
  try {
    tmpDir = createDownloadTmpDir();
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to prepare temp dir: ${sanitizeError(err.message)}`,
    };
  }
  const tarballPath = path.join(tmpDir, 'archive.tar.gz');

  try {
    fs.mkdirSync(destDir, { recursive: true });
    curlDownload(repo, tag, 'tag', tarballPath);
    const commit = archiveCommit(tarballPath);
    const result = extractTarball(tarballPath, destDir);
    removeOwnedTree(path.dirname(tmpDir), tmpDir);
    return result.success ? { ...result, ref: tag, refType: 'tag', commit } : result;
  } catch (err) {
    removeOwnedTree(path.dirname(tmpDir), tmpDir);
    return {
      success: false,
      extractedDir: null,
      error: `Failed to download ${repo}@${tag}: ${sanitizeError(err.message)}`,
    };
  }
}

/**
 * Copy a component from a local path.
 *
 * @param {string} localPath - Absolute or relative path to component source
 * @param {string} destDir - Destination directory
 * @returns {{ success: boolean, error?: string }}
 */
export function copyLocal(localPath, destDir) {
  const srcPath = resolveLocalPath(localPath);

  if (!fs.existsSync(srcPath)) {
    return { success: false, error: `Source path not found: ${srcPath}` };
  }

  const stat = fs.statSync(srcPath);
  if (!stat.isDirectory()) {
    return { success: false, error: `Source path is not a directory: ${srcPath}` };
  }

  try {
    copyTree(srcPath, destDir, { excludes: ['.git', 'node_modules', '.zylos', '.backup'] });
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to copy from ${srcPath}: ${err.message}` };
  }
}

/**
 * Inspect a local source without coupling target resolution to the add command.
 * Local tarballs are unpacked to a temporary directory for metadata discovery.
 *
 * @param {string} localPath
 * @returns {{ name: string, version: string | null, source: object }}
 */
export function inspectLocalSource(localPath) {
  const srcPath = resolveLocalPath(localPath);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Local source not found: ${srcPath}`);
  }

  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    const metadata = readLocalMetadata(srcPath, path.basename(srcPath));
    return { ...metadata, source: { type: 'local-dir', path: srcPath } };
  }

  if (!stat.isFile() || !/\.(?:tar\.gz|tgz)$/i.test(srcPath)) {
    throw new Error(`Local source must be a directory or .tar.gz archive: ${srcPath}`);
  }

  const tmpDir = createDownloadTmpDir();
  try {
    const result = extractLocalTarball(srcPath, tmpDir);
    if (!result.success) throw new Error(result.error);
    const fallback = path.basename(srcPath).replace(/\.(?:tar\.gz|tgz)$/i, '');
    const metadata = readLocalMetadata(tmpDir, fallback);
    return { ...metadata, source: { type: 'local-tarball', path: srcPath } };
  } finally {
    removeOwnedTree(path.dirname(tmpDir), tmpDir);
  }
}

/**
 * Acquire a normalized component source into its installation directory.
 * Resolver registration keeps source-specific behavior at the acquire boundary
 * and leaves manifest, registration, hooks, PM2, and Caddy flows source-agnostic.
 *
 * @param {object} source
 * @param {string} destDir
 * @returns {{ success: boolean, extractedDir?: string, error?: string }}
 */
export function acquireSource(source, destDir) {
  const resolver = SOURCE_RESOLVERS.get(source?.type);
  if (!resolver) {
    return { success: false, error: `Unsupported component source: ${source?.type || 'unknown'}` };
  }
  try {
    return resolver.acquire(source, destDir);
  } catch (err) {
    return { success: false, error: sanitizeError(err.message) };
  }
}

/**
 * Register an additional source resolver. This is the upgrade/mirror extension
 * seam; v1 ships only GitHub releases/branches and local filesystem sources.
 */
export function registerSourceResolver(type, resolver) {
  if (!type || typeof resolver?.acquire !== 'function') {
    throw new TypeError('A source resolver requires a type and acquire(source, destDir)');
  }
  SOURCE_RESOLVERS.set(type, resolver);
}

const SOURCE_RESOLVERS = new Map();

registerSourceResolver('github-release', {
  acquire(source, destDir) {
    if (source.refType === 'branch') {
      return downloadBranch(source.repo, source.ref, destDir);
    }
    return downloadArchive(source.repo, source.ref, destDir);
  },
});

registerSourceResolver('local-dir', {
  acquire(source, destDir) {
    return copyLocal(source.path, destDir);
  },
});

registerSourceResolver('local-tarball', {
  acquire(source, destDir) {
    return extractLocalTarball(source.path, destDir);
  },
});

/**
 * Download a GitHub branch archive and extract it.
 * Used for versionless installs (no tagged release).
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} branch - Branch name (e.g. "main")
 * @param {string} destDir - Destination directory to extract into
 * @returns {{ success: boolean, extractedDir: string, ref?: string, refType?: 'branch', commit?: string|null, error?: string }}
 *   On success, `commit` is the commit the branch archive was made from: the branch moves, the record must not.
 */
export function downloadBranch(repo, branch, destDir) {
  let tmpDir;
  try {
    tmpDir = createDownloadTmpDir();
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to prepare temp dir: ${sanitizeError(err.message)}`,
    };
  }
  const tarballPath = path.join(tmpDir, 'archive.tar.gz');

  try {
    fs.mkdirSync(destDir, { recursive: true });
    curlDownload(repo, branch, 'branch', tarballPath);
    const commit = archiveCommit(tarballPath);
    const result = extractTarball(tarballPath, destDir);
    removeOwnedTree(path.dirname(tmpDir), tmpDir);
    return result.success ? { ...result, ref: branch, refType: 'branch', commit } : result;
  } catch (err) {
    removeOwnedTree(path.dirname(tmpDir), tmpDir);
    return {
      success: false,
      extractedDir: null,
      error: `Failed to download ${repo}@${branch}: ${sanitizeError(err.message)}`,
    };
  }
}

/**
 * Extract a tarball to a destination directory.
 * GitHub archive tarballs contain a top-level directory (e.g. "repo-name-v1.0.0/"),
 * so we strip the first path component.
 *
 * @param {string} tarballPath - Path to the .tar.gz file
 * @param {string} destDir - Directory to extract into
 * @returns {{ success: boolean, extractedDir: string, error?: string }}
 */
export function extractTarball(tarballPath, destDir) {
  try {
    fs.mkdirSync(destDir, { recursive: true });

    // Extract with strip-components to remove top-level directory
    execFileSync('tar', ['xzf', tarballPath, '-C', destDir, '--strip-components=1'], {
      timeout: 30000,
      stdio: 'pipe',
    });

    return { success: true, extractedDir: destDir };
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to extract tarball: ${err.message}`,
    };
  }
}

export function resolveLocalPath(localPath) {
  if (localPath === '~') return fs.realpathSync(os.homedir());
  const expanded = localPath.startsWith('~/')
    ? path.join(os.homedir(), localPath.slice(2))
    : localPath;
  return path.resolve(expanded);
}

function readLocalMetadata(componentDir, fallbackName) {
  const frontmatter = parseSkillMd(componentDir)?.frontmatter || {};
  const name = normalizeLocalComponentName(frontmatter.name || fallbackName);
  let version = frontmatter.version == null ? null : String(frontmatter.version).trim();
  if (!version) {
    try {
      version = fs.readFileSync(path.join(componentDir, 'VERSION'), 'utf8').trim() || null;
    } catch {
      version = null;
    }
  }
  if (!version) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(componentDir, 'package.json'), 'utf8'));
      version = pkg.version == null ? null : String(pkg.version).trim() || null;
    } catch {
      version = null;
    }
  }
  return { name, version };
}

function normalizeLocalComponentName(value) {
  const name = String(value).trim().replace(/^zylos-/, '');
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid local component name: ${value}`);
  }
  return name;
}

function extractLocalTarball(tarballPath, destDir) {
  try {
    const srcPath = resolveLocalPath(tarballPath);
    if (!fs.existsSync(srcPath)) {
      return { success: false, extractedDir: null, error: `Local source not found: ${srcPath}` };
    }

    const listing = execFileSync('tar', ['tzf', srcPath], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entries = listing
      .split('\n')
      .map(entry => entry.replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean);
    if (entries.length === 0) {
      return { success: false, extractedDir: null, error: 'Local tarball is empty' };
    }
    if (entries.some(isUnsafeArchivePath)) {
      return { success: false, extractedDir: null, error: 'Local tarball contains an unsafe path' };
    }

    const verboseListing = execFileSync('tar', ['tvzf', srcPath], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const linkEntry = verboseListing
      .split('\n')
      .find(line => line.startsWith('l') || line.startsWith('h'));
    if (linkEntry) {
      return {
        success: false,
        extractedDir: null,
        error: 'Local tarball contains a symbolic or hard link; links are not allowed',
      };
    }

    const firstParts = new Set(entries.map(entry => entry.split('/')[0]));
    const hasSingleWrapper = firstParts.size === 1 && entries.some(entry => entry.includes('/'));
    fs.mkdirSync(destDir, { recursive: true });
    const args = ['xzf', srcPath, '-C', destDir];
    if (hasSingleWrapper) args.push('--strip-components=1');
    execFileSync('tar', args, { timeout: 30000, stdio: 'pipe' });
    return { success: true, extractedDir: destDir, commit: archiveCommit(srcPath) };
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to extract local tarball: ${sanitizeError(err.message)}`,
    };
  }
}

function isUnsafeArchivePath(entry) {
  if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) return true;
  return entry.split(/[\\/]+/).some(part => part === '..');
}
