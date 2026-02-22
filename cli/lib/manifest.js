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
function hashFile(filePath) {
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
 * Save copies of source files as "originals" for future three-way merge.
 * Stored in componentDir/.zylos/originals/ mirroring the source structure.
 *
 * @param {string} componentDir - Installed component root directory
 * @param {string} sourceDir    - Source directory (e.g., temp dir with new version)
 */
export function saveOriginals(componentDir, sourceDir) {
  const originalsDir = path.join(componentDir, MANIFEST_DIR, ORIGINALS_DIR);

  // Clean previous originals
  if (fs.existsSync(originalsDir)) {
    fs.rmSync(originalsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(originalsDir, { recursive: true });

  const files = collectFiles(sourceDir, sourceDir);
  for (const file of files) {
    const destPath = path.join(originalsDir, file);
    assertWithinDir(destPath, originalsDir, file);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, file), destPath);
  }
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
