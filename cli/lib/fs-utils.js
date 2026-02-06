/**
 * Filesystem utilities — pure Node.js replacements for rsync.
 * No external tool dependencies (rsync, cp, etc.).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Check if a relative path should be excluded.
 * Matches top-level directory names (e.g., 'node_modules', '.git').
 *
 * @param {string} relativePath - Path relative to the copy root
 * @param {string[]} excludes - Top-level directory/file names to skip
 * @returns {boolean}
 */
function isExcluded(relativePath, excludes) {
  if (!relativePath || !excludes.length) return false;
  const topLevel = relativePath.split(path.sep)[0];
  return excludes.includes(topLevel);
}

/**
 * Copy a directory tree, optionally excluding certain top-level entries.
 * Equivalent to: rsync -a --exclude=... src/ dest/
 *
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @param {object} [opts]
 * @param {string[]} [opts.excludes=[]] - Top-level names to exclude
 */
export function copyTree(src, dest, { excludes = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });

  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (!rel) return true; // root directory itself
      return !isExcluded(rel, excludes);
    },
  });
}

/**
 * Sync a directory tree: copy from src to dest, removing extra files in dest.
 * Equivalent to: rsync -a --delete --exclude=... src/ dest/
 *
 * Steps:
 * 1. Remove non-excluded entries in dest that will be overwritten
 * 2. Copy from src (excluding specified entries)
 *
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @param {object} [opts]
 * @param {string[]} [opts.excludes=[]] - Top-level names to preserve in dest and skip from src
 */
export function syncTree(src, dest, { excludes = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });

  // Remove non-excluded entries in dest (equivalent to rsync --delete)
  for (const entry of fs.readdirSync(dest)) {
    if (excludes.includes(entry)) continue;
    fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
  }

  // Copy from src, skipping excluded entries
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (!rel) return true;
      return !isExcluded(rel, excludes);
    },
  });
}
