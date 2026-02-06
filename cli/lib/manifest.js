/**
 * Manifest utilities for tracking file hashes.
 * Used to detect local modifications during upgrades.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_DIR = '.zylos';
const MANIFEST_FILE = 'manifest.json';

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
function generateManifest(dir) {
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
function saveManifest(dir, manifest) {
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
function loadManifest(dir) {
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

/**
 * Detect local modifications by comparing current files against saved manifest.
 *
 * @param {string} dir - Component root directory
 * @returns {{ modified: string[], added: string[], deleted: string[], unchanged: string[] } | null}
 *   null if no manifest found (first install, no comparison possible)
 */
function detectChanges(dir) {
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

module.exports = {
  generateManifest,
  saveManifest,
  loadManifest,
  detectChanges,
};
