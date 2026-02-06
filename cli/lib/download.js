/**
 * Download utilities for component installation and upgrades.
 * Supports GitHub archive tarballs and local paths. No git dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

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
  const url = `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-'));
  const tarballPath = path.join(tmpDir, 'archive.tar.gz');

  try {
    // Ensure dest directory exists
    fs.mkdirSync(destDir, { recursive: true });

    // Download tarball
    execSync(`curl -fsSL -o "${tarballPath}" "${url}"`, {
      timeout: 60000,
      stdio: 'pipe',
    });

    // Extract tarball
    const result = extractTarball(tarballPath, destDir);

    // Clean up tarball
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return result;
  } catch (err) {
    // Clean up on failure
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      success: false,
      extractedDir: null,
      error: `Failed to download ${repo}@${tag}: ${err.message}`,
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
    fs.mkdirSync(destDir, { recursive: true });
    // Copy all files except .git
    execSync(`rsync -a --exclude='.git' "${srcPath}/" "${destDir}/"`, {
      timeout: 30000,
      stdio: 'pipe',
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to copy from ${srcPath}: ${err.message}` };
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
    execSync(`tar xzf "${tarballPath}" -C "${destDir}" --strip-components=1`, {
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
