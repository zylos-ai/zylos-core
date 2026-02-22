/**
 * Smart merge: three-way merge for upgrade conflict resolution.
 *
 * Replaces the old "preserve" strategy. Every file gets a definitive outcome:
 * - overwrite: local unmodified, new version applied
 * - keep: local modified, new version unchanged (local is the only delta)
 * - merged: both sides changed, diff3 produced a clean merge
 * - overwritten: both sides changed, conflict — new version wins, local backed up
 *
 * The backup serves as a safety net. In conversation mode, Claude can review
 * backed-up files and perform intelligent re-merging. In CLI mode, the user
 * is prompted to let Claude review after the upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateManifest,
  loadManifest,
  saveManifest,
  saveOriginals,
  getOriginalContent,
  hasOriginals,
} from './manifest.js';
import { isDiff3Available, merge3 } from './diff3.js';

/**
 * @typedef {Object} MergeResult
 * @property {string[]} overwritten  - Files overwritten (local unmodified)
 * @property {string[]} kept         - Files kept (only local modified, new unchanged)
 * @property {string[]} merged       - Files auto-merged via diff3
 * @property {ConflictFile[]} conflicts - Files where local was backed up, new version written
 * @property {string[]} added        - New files added
 * @property {string[]} deleted      - Files deleted (removed in new version)
 * @property {string[]} errors       - Error descriptions
 */

/**
 * @typedef {Object} ConflictFile
 * @property {string} file       - Relative file path
 * @property {string} backupPath - Absolute path to backed-up local version
 */

/**
 * Smart sync: merge files from srcDir into destDir using three-way strategy.
 *
 * @param {string} srcDir  - New version source directory
 * @param {string} destDir - Installed destination directory
 * @param {object} [opts]
 * @param {string} [opts.label]    - Label for this component/skill (for logging)
 * @param {string} [opts.backupDir] - Directory to store backed-up conflict files
 * @param {string} [opts.mode]     - 'merge' (default) or 'overwrite' (skip merge, overwrite all)
 * @returns {MergeResult}
 */
export function smartSync(srcDir, destDir, opts = {}) {
  const { label = '', backupDir, mode = 'merge' } = opts;

  /** @type {MergeResult} */
  const result = {
    overwritten: [],
    kept: [],
    merged: [],
    conflicts: [],
    added: [],
    deleted: [],
    errors: [],
  };

  const savedManifest = loadManifest(destDir);
  const newManifest = generateManifest(srcDir);
  const diff3Available = isDiff3Available();
  const originalsExist = hasOriginals(destDir);

  // Generate current manifest for comparison (if we have a saved one)
  let currentManifest;
  if (savedManifest) {
    currentManifest = generateManifest(destDir);
  }

  for (const [relPath, newHash] of Object.entries(newManifest.files)) {
    const srcFile = path.join(srcDir, relPath);
    const destFile = path.join(destDir, relPath);

    // New file — just add it
    if (!fs.existsSync(destFile)) {
      try {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(srcFile, destFile);
        result.added.push(relPath);
      } catch (err) {
        result.errors.push(`${relPath}: add failed: ${err.message}`);
      }
      continue;
    }

    // Overwrite mode — skip merge logic, always overwrite
    if (mode === 'overwrite') {
      try {
        fs.copyFileSync(srcFile, destFile);
        result.overwritten.push(relPath);
      } catch (err) {
        result.errors.push(`${relPath}: overwrite failed: ${err.message}`);
      }
      continue;
    }

    // No manifest — can't tell if user modified; treat as overwrite
    if (!savedManifest) {
      try {
        fs.copyFileSync(srcFile, destFile);
        result.overwritten.push(relPath);
      } catch (err) {
        result.errors.push(`${relPath}: overwrite failed: ${err.message}`);
      }
      continue;
    }

    const savedHash = savedManifest.files[relPath];
    const currentHash = currentManifest.files[relPath];

    // File didn't exist in previous manifest — user may have added it.
    // Treat as conflict: backup the user's local version, write new version.
    if (!savedHash) {
      try {
        if (backupDir) {
          const backupPath = path.join(backupDir, relPath);
          fs.mkdirSync(path.dirname(backupPath), { recursive: true });
          fs.copyFileSync(destFile, backupPath);
          result.conflicts.push({ file: relPath, backupPath });
        } else {
          result.conflicts.push({ file: relPath, backupPath: null });
        }
        fs.copyFileSync(srcFile, destFile);
      } catch (err) {
        result.errors.push(`${relPath}: conflict handling failed: ${err.message}`);
      }
      continue;
    }

    const localModified = currentHash !== savedHash;
    const newChanged = newHash !== savedHash;

    if (!localModified) {
      // Local unmodified — safe to overwrite
      if (newChanged) {
        try {
          fs.copyFileSync(srcFile, destFile);
          result.overwritten.push(relPath);
        } catch (err) {
          result.errors.push(`${relPath}: overwrite failed: ${err.message}`);
        }
      }
      // else: neither changed, nothing to do
      continue;
    }

    if (!newChanged) {
      // Only local modified, new version unchanged — keep local
      result.kept.push(relPath);
      continue;
    }

    // Both sides changed — attempt three-way merge
    const localContent = fs.readFileSync(destFile, 'utf8');
    const newContent = fs.readFileSync(srcFile, 'utf8');
    let baseContent = null;

    if (originalsExist) {
      baseContent = getOriginalContent(destDir, relPath);
    }

    if (baseContent !== null && diff3Available) {
      try {
        const mergeResult = merge3(baseContent, localContent, newContent);
        if (mergeResult.clean) {
          // Clean merge — write result
          fs.writeFileSync(destFile, mergeResult.content);
          result.merged.push(relPath);
          continue;
        }
      } catch {
        // diff3 error — fall through to overwrite+backup
      }
    }

    // Cannot merge (no originals, no diff3, or conflict) — overwrite + backup local
    try {
      if (backupDir) {
        const backupPath = path.join(backupDir, relPath);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(destFile, backupPath);
        result.conflicts.push({ file: relPath, backupPath });
      } else {
        result.conflicts.push({ file: relPath, backupPath: null });
      }
      fs.copyFileSync(srcFile, destFile);
    } catch (err) {
      result.errors.push(`${relPath}: conflict handling failed: ${err.message}`);
    }
  }

  // Delete files that were in the old version but removed in the new version.
  // Only delete files tracked in the old manifest — user-added files are preserved.
  if (savedManifest) {
    const newFiles = new Set(Object.keys(newManifest.files));
    for (const file of Object.keys(savedManifest.files)) {
      if (!newFiles.has(file)) {
        const destFile = path.join(destDir, file);
        try {
          fs.unlinkSync(destFile);
          result.deleted.push(file);
          // Clean up empty parent directories
          let dir = path.dirname(destFile);
          while (dir !== destDir) {
            const entries = fs.readdirSync(dir);
            if (entries.length > 0) break;
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            result.errors.push(`${file}: delete failed: ${err.message}`);
          }
        }
      }
    }
  }

  // Save originals from the new version (for next upgrade's three-way merge)
  try {
    saveOriginals(destDir, srcDir);
  } catch (err) {
    result.errors.push(`save originals: ${err.message}`);
  }

  // Update manifest to reflect current state after sync
  try {
    const updatedManifest = generateManifest(destDir);
    saveManifest(destDir, updatedManifest);
  } catch (err) {
    result.errors.push(`update manifest: ${err.message}`);
  }

  return result;
}

/**
 * Format a MergeResult into a human-readable summary string.
 *
 * @param {MergeResult} result
 * @returns {string}
 */
export function formatMergeResult(result) {
  const parts = [];
  if (result.overwritten.length) parts.push(`${result.overwritten.length} overwritten`);
  if (result.kept.length) parts.push(`${result.kept.length} kept`);
  if (result.merged.length) parts.push(`${result.merged.length} merged`);
  if (result.conflicts.length) parts.push(`${result.conflicts.length} conflicts`);
  if (result.added.length) parts.push(`${result.added.length} added`);
  if (result.deleted.length) parts.push(`${result.deleted.length} deleted`);
  if (result.errors.length) parts.push(`${result.errors.length} errors`);
  return parts.join(', ') || 'no changes';
}
