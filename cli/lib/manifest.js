/**
 * Manifest utilities for tracking file hashes.
 * Used to detect local modifications during upgrades.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MANIFEST_DIR = '.zylos';
const MANIFEST_FILE = 'manifest.json';
const ORIGINALS_DIR = 'originals';

/**
 * Validate that a resolved path stays within the expected base directory.
 * Prevents path traversal via ../ sequences in relative paths.
 */
function assertWithinDir(resolved, baseDir, relPath) {
  const normalBase = path.resolve(baseDir) + path.sep;
  const normalResolved = path.resolve(resolved);
  if (!normalResolved.startsWith(normalBase) && normalResolved !== path.resolve(baseDir)) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
}

/**
 * Compute SHA-256 hash of a file.
 *
 * @param {string} filePath - Absolute path to file
 * @returns {string} Hex-encoded hash
 */
export function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collect all files in a directory, excluding certain paths.
 *
 * @param {string} dir - Directory to scan
 * @param {string} baseDir - Base directory for relative paths
 * @param {string[]} [exclude] - Directory/file names to skip
 * @returns {string[]} Array of relative file paths
 */
function collectFiles(dir, baseDir, exclude = ['.git', '.zylos', 'node_modules', '.backup']) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir, exclude));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath));
    }
  }

  return files;
}

/**
 * Generate a manifest (file hash map) for a directory.
 *
 * @param {string} dir - Directory to scan
 * @returns {{ files: Object<string, string>, generated_at: string }}
 */
export function generateManifest(dir) {
  const files = collectFiles(dir, dir);
  const manifest = {};

  for (const file of files.sort()) {
    manifest[file] = hashFile(path.join(dir, file));
  }

  return {
    files: manifest,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Save manifest to the component's .zylos/ directory.
 *
 * @param {string} dir - Component root directory
 * @param {Object} manifest - Manifest object from generateManifest()
 */
export function saveManifest(dir, manifest) {
  const manifestDir = path.join(dir, MANIFEST_DIR);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2)
  );
}

/**
 * Load manifest from a component's .zylos/ directory.
 *
 * @param {string} dir - Component root directory
 * @returns {Object|null} Manifest object or null if not found
 */
export function loadManifest(dir) {
  const manifestPath = path.join(dir, MANIFEST_DIR, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Originals: store installed file copies for three-way merge
// ---------------------------------------------------------------------------

/**
 * Copy source files into a target directory, mirroring the source structure.
 * Replaces any previous content at targetDir.
 */
function copyOriginalsTo(targetDir, sourceDir) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const files = collectFiles(sourceDir, sourceDir);
  for (const file of files) {
    const destPath = path.join(targetDir, file);
    assertWithinDir(destPath, targetDir, file);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, file), destPath);
  }
}

/**
 * Save copies of source files as "originals" for future three-way merge.
 * Stored in componentDir/.zylos/originals/ mirroring the source structure.
 *
 * @param {string} componentDir - Installed component root directory
 * @param {string} sourceDir    - Source directory (e.g., temp dir with new version)
 */
export function saveOriginals(componentDir, sourceDir) {
  copyOriginalsTo(path.join(componentDir, MANIFEST_DIR, ORIGINALS_DIR), sourceDir);
}

const MANIFEST_TMP = MANIFEST_FILE + '.tmp';
const ORIGINALS_NEW = ORIGINALS_DIR + '.new';
const ORIGINALS_LEGACY_BAK = ORIGINALS_DIR + '.bak';

/**
 * Check that a directory of original copies is exactly the generation the
 * manifest describes: same file membership, every hash matching.
 *
 * Deliberately compares manifest ↔ originals ONLY — live installed files
 * never participate. Live files are allowed to carry local modifications
 * (that is why originals exist as a merge base); including them would make
 * any legitimate local edit look like a broken baseline.
 */
function dirMatchesManifest(dir, manifest) {
  if (!manifest || !manifest.files) return false;
  if (!fs.existsSync(dir)) return false;
  const present = collectFiles(dir, dir).sort();
  const tracked = Object.keys(manifest.files).sort();
  if (present.length !== tracked.length) return false;
  for (let i = 0; i < present.length; i++) {
    if (present[i] !== tracked[i]) return false;
  }
  for (const [relPath, hash] of Object.entries(manifest.files)) {
    const filePath = path.join(dir, relPath);
    assertWithinDir(filePath, dir, relPath);
    if (hashFile(filePath) !== hash) return false;
  }
  return true;
}

/**
 * Recover an interrupted baseline transaction. Idempotent — safe to run any
 * number of times, and safe to re-run if recovery itself is interrupted.
 *
 * States (commit point = atomic rename of the staged manifest onto the live
 * manifest; the staged manifest's presence is the discriminator):
 * - staged manifest present  → transaction never committed → roll back:
 *   discard all staged artifacts, live pair untouched.
 * - staged originals present, no staged manifest → committed, originals swap
 *   interrupted → roll forward: staged originals become live.
 * - legacy `originals.bak` (pre-transaction staging scheme) → three-state:
 *   live originals exactly match the manifest → committed generation, drop
 *   the backup; else the backup exactly matches the manifest → provably the
 *   right generation, restore it; else neither matches → do NOT guess or
 *   delete either side — throw a recovery error and preserve the site for
 *   manual inspection.
 *
 * @param {string} componentDir - Installed component root directory
 * @throws {Error} legacy-backup state where neither candidate matches the manifest
 */
export function recoverMergeBaseline(componentDir) {
  const zylosDir = path.join(componentDir, MANIFEST_DIR);
  if (!fs.existsSync(zylosDir)) return;

  const originalsDir = path.join(zylosDir, ORIGINALS_DIR);
  const stagedManifest = path.join(zylosDir, MANIFEST_TMP);
  const stagedOriginals = path.join(zylosDir, ORIGINALS_NEW);
  const legacyBackup = path.join(zylosDir, ORIGINALS_LEGACY_BAK);

  if (fs.existsSync(stagedManifest)) {
    // Commit never happened — discard staging, live pair is the baseline
    fs.rmSync(stagedManifest, { recursive: true, force: true });
    fs.rmSync(stagedOriginals, { recursive: true, force: true });
  } else if (fs.existsSync(stagedOriginals)) {
    // Manifest committed but originals swap interrupted — roll forward
    fs.rmSync(originalsDir, { recursive: true, force: true });
    fs.renameSync(stagedOriginals, originalsDir);
  }

  if (fs.existsSync(legacyBackup)) {
    const manifest = loadManifest(componentDir);
    if (dirMatchesManifest(originalsDir, manifest)) {
      // Live originals are the committed generation — backup is stale
      fs.rmSync(legacyBackup, { recursive: true, force: true });
    } else if (dirMatchesManifest(legacyBackup, manifest)) {
      // Backup provably matches the live manifest — restore it
      fs.rmSync(originalsDir, { recursive: true, force: true });
      fs.renameSync(legacyBackup, originalsDir);
    } else {
      // Neither candidate matches the manifest (disk damage, unknown
      // history): guessing could "repair" into a different inconsistency.
      // Preserve the site and surface the state.
      throw new Error(
        `baseline recovery: ${ORIGINALS_LEGACY_BAK} present but neither active originals nor the backup match the manifest — manual inspection required in ${zylosDir}`
      );
    }
  }
}

/**
 * Save manifest + originals as one atomic group: consumers only ever observe
 * the old baseline pair or the new one, never a mix — across write failures,
 * persistent I/O errors, and process crashes at any point.
 *
 * Protocol: stage both pieces without touching the live baseline (originals
 * into `originals.new`, manifest into `manifest.json.tmp`), then commit by
 * atomically renaming the staged manifest onto the live path — the live
 * manifest is never opened for writing, so no failure mode can truncate it.
 * After the commit, the originals swap is completed; if interrupted, the next
 * recoverMergeBaseline() rolls it forward.
 *
 * Upgrade rollback excludes .zylos, so nothing else repairs this metadata —
 * it has to protect itself (issue #715 review findings, R1+R2).
 *
 * @param {string} componentDir - Installed component root directory
 * @param {string} sourceDir    - New version source directory
 * @param {Object} manifest     - Manifest generated from sourceDir
 */
export function saveMergeBaseline(componentDir, sourceDir, manifest) {
  recoverMergeBaseline(componentDir);

  const zylosDir = path.join(componentDir, MANIFEST_DIR);
  fs.mkdirSync(zylosDir, { recursive: true });

  const manifestPath = path.join(zylosDir, MANIFEST_FILE);
  const originalsDir = path.join(zylosDir, ORIGINALS_DIR);
  const stagedManifest = path.join(zylosDir, MANIFEST_TMP);
  const stagedOriginals = path.join(zylosDir, ORIGINALS_NEW);

  try {
    // Stage. The staged manifest is written FIRST: its presence marks the
    // transaction as uncommitted, so a crash while staging originals is
    // rolled back, never mistaken for a committed generation.
    fs.writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2));
    copyOriginalsTo(stagedOriginals, sourceDir);
    // Commit point (atomic)
    fs.renameSync(stagedManifest, manifestPath);
  } catch (err) {
    // Discard staging; the live pair was never touched
    try { fs.rmSync(stagedManifest, { recursive: true, force: true }); } catch { /* keep original error */ }
    try { fs.rmSync(stagedOriginals, { recursive: true, force: true }); } catch { /* keep original error */ }
    throw err;
  }

  // Post-commit: make the staged originals live. Any interruption here is
  // rolled forward by the next recoverMergeBaseline().
  fs.rmSync(originalsDir, { recursive: true, force: true });
  fs.renameSync(stagedOriginals, originalsDir);
}

/**
 * Read an original file's content (from a previous install).
 *
 * @param {string} componentDir - Installed component root directory
 * @param {string} relPath      - Relative path to the file
 * @returns {string|null} File content or null if not found
 */
export function getOriginalContent(componentDir, relPath) {
  const filePath = path.join(componentDir, MANIFEST_DIR, ORIGINALS_DIR, relPath);
  assertWithinDir(filePath, path.join(componentDir, MANIFEST_DIR, ORIGINALS_DIR), relPath);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Check if originals are stored for a component.
 *
 * @param {string} componentDir - Installed component root directory
 * @returns {boolean}
 */
export function hasOriginals(componentDir) {
  return fs.existsSync(path.join(componentDir, MANIFEST_DIR, ORIGINALS_DIR));
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Detect local modifications by comparing current files against saved manifest.
 *
 * @param {string} dir - Component root directory
 * @returns {{ modified: string[], added: string[], deleted: string[], unchanged: string[] } | null}
 *   null if no manifest found (first install, no comparison possible)
 */
export function detectChanges(dir) {
  const saved = loadManifest(dir);
  if (!saved || !saved.files) return null;

  const current = generateManifest(dir);
  const modified = [];
  const added = [];
  const deleted = [];
  const unchanged = [];

  // Check files that exist now
  for (const [file, hash] of Object.entries(current.files)) {
    if (!(file in saved.files)) {
      added.push(file);
    } else if (saved.files[file] !== hash) {
      modified.push(file);
    } else {
      unchanged.push(file);
    }
  }

  // Check files that were in manifest but no longer exist
  for (const file of Object.keys(saved.files)) {
    if (!(file in current.files)) {
      deleted.push(file);
    }
  }

  return { modified, added, deleted, unchanged };
}
