/**
 * Download utilities for component installation and upgrades.
 * Supports GitHub archive tarballs and local paths. No git dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { getGitHubToken, sanitizeError, withRateLimitRetrySync } from './github.js';
import { copyTree } from './fs-utils.js';
import { parseSkillMd } from './skill.js';

function getWritableTmpBase() {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(base, 'zylos-download-probe-'));
    fs.rmSync(probe, { recursive: true, force: true });
  } catch {
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
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
  withRateLimitRetrySync(
    () => curlDownloadOnce(repo, ref, refType, tarballPath),
    `${repo}@${ref}`
  );
}

function curlDownloadOnce(repo, ref, refType, tarballPath) {
  // 1. Try public endpoint first (no auth needed for public repos)
  const publicUrl = refType === 'tag'
    ? `https://github.com/${repo}/archive/refs/tags/${ref}.tar.gz`
    : `https://github.com/${repo}/archive/refs/heads/${ref}.tar.gz`;
  try {
    execFileSync('curl', ['-fsSL', '-o', tarballPath, publicUrl], {
      timeout: 60000,
      stdio: 'pipe',
    });
    return;
  } catch {
    // Public download failed — repo may be private, try with auth
  }

  // 2. Fall back to authenticated GitHub API (for private repos)
  const token = getGitHubToken();
  if (!token) {
    // No token available — re-throw by attempting public download again
    // (this gives the caller the original error message)
    execFileSync('curl', ['-fsSL', '-o', tarballPath, publicUrl], {
      timeout: 60000,
      stdio: 'pipe',
    });
    return;
  }

  const apiUrl = `https://api.github.com/repos/${repo}/tarball/${ref}`;
  execFileSync('curl', ['-fsSL', '-H', `Authorization: Bearer ${token}`, '-o', tarballPath, apiUrl], {
    timeout: 60000,
    stdio: 'pipe',
  });
}

/**
 * Download a GitHub archive tarball and extract it.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} version - Version tag (e.g. "1.0.0", will be prefixed with "v")
 * @param {string} destDir - Destination directory to extract into
 * @returns {{ success: boolean, extractedDir: string, error?: string }}
 */
export function downloadArchive(repo, version, destDir) {
  const tag = version.startsWith('v') ? version : `v${version}`;
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
    const result = extractTarball(tarballPath, destDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return result;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
  const srcPath = path.resolve(localPath);

  if (!fs.existsSync(srcPath)) {
    return { success: false, error: `Source path not found: ${srcPath}` };
  }

  const stat = fs.statSync(srcPath);
  if (!stat.isDirectory()) {
    return { success: false, error: `Source path is not a directory: ${srcPath}` };
  }

  try {
    copyTree(srcPath, destDir, { excludes: ['.git'] });
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
 * @returns {{ success: boolean, extractedDir: string, error?: string }}
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
    const result = extractTarball(tarballPath, destDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return result;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

function resolveLocalPath(localPath) {
  if (localPath === '~') return fs.realpathSync(process.env.HOME);
  const expanded = localPath.startsWith('~/')
    ? path.join(process.env.HOME, localPath.slice(2))
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
    const srcPath = path.resolve(tarballPath);
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

    const firstParts = new Set(entries.map(entry => entry.split('/')[0]));
    const hasSingleWrapper = firstParts.size === 1 && entries.some(entry => entry.includes('/'));
    fs.mkdirSync(destDir, { recursive: true });
    const args = ['xzf', srcPath, '-C', destDir];
    if (hasSingleWrapper) args.push('--strip-components=1');
    execFileSync('tar', args, { timeout: 30000, stdio: 'pipe' });
    return { success: true, extractedDir: destDir };
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to extract local tarball: ${sanitizeError(err.message)}`,
    };
  }
}
