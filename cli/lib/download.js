/**
 * Download utilities for component installation and upgrades.
 * Supports GitHub archive tarballs and local paths. No git dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { getGitHubToken, sanitizeError } from './github.js';
import { copyTree } from './fs-utils.js';

/**
 * Download a tarball from a URL using curl.
 * When a GitHub token is available, uses the GitHub API endpoint
 * (works for both public and private repos).
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} ref - Git ref (tag name or branch name)
 * @param {'tag'|'branch'} refType - Whether the ref is a tag or branch
 * @param {string} tarballPath - Destination file path for the tarball
 */
function curlDownload(repo, ref, refType, tarballPath) {
  const token = getGitHubToken();

  if (token) {
    // GitHub API endpoint — works for public and private repos
    const url = `https://api.github.com/repos/${repo}/tarball/${ref}`;
    execFileSync('curl', ['-fsSL', '-H', `Authorization: Bearer ${token}`, '-o', tarballPath, url], {
      timeout: 60000,
      stdio: 'pipe',
    });
  } else {
    // Public endpoint — only works for public repos
    const url = refType === 'tag'
      ? `https://github.com/${repo}/archive/refs/tags/${ref}.tar.gz`
      : `https://github.com/${repo}/archive/refs/heads/${ref}.tar.gz`;
    execFileSync('curl', ['-fsSL', '-o', tarballPath, url], {
      timeout: 60000,
      stdio: 'pipe',
    });
  }
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-'));
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
 * Download a GitHub branch archive and extract it.
 * Used for versionless installs (no tagged release).
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} branch - Branch name (e.g. "main")
 * @param {string} destDir - Destination directory to extract into
 * @returns {{ success: boolean, extractedDir: string, error?: string }}
 */
export function downloadBranch(repo, branch, destDir) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-'));
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
