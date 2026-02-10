/**
 * Bin symlink management for SKILL.md `bin` field.
 *
 * Creates and removes symlinks in ~/zylos/bin/ so component CLIs
 * are available on $PATH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BIN_DIR } from './config.js';

/**
 * Create symlinks in BIN_DIR for each entry in the SKILL.md `bin` field.
 *
 * @param {string} skillDir - Absolute path to the component's skill directory
 * @param {object} binField - e.g. { "zylos-browser": "src/cli.js" }
 * @returns {object|null} Mapping of command names to symlink paths, or null if nothing to link
 */
export function linkBins(skillDir, binField) {
  if (!binField || typeof binField !== 'object' || Object.keys(binField).length === 0) {
    return null;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const result = {};

  for (const [cmdName, scriptPath] of Object.entries(binField)) {
    const target = path.join(skillDir, scriptPath);
    const link = path.join(BIN_DIR, cmdName);

    // Validate target exists
    if (!fs.existsSync(target)) {
      console.log(`  Warning: bin target not found: ${target}`);
      continue;
    }

    // Make target executable
    try {
      fs.chmodSync(target, 0o755);
    } catch (err) {
      console.log(`  Warning: could not chmod ${target}: ${err.message}`);
    }

    // Remove existing file/symlink at link path
    try {
      const stat = fs.lstatSync(link);
      if (stat) {
        if (stat.isSymbolicLink()) {
          const existing = fs.readlinkSync(link);
          if (existing !== target) {
            console.log(`  Warning: overwriting existing bin link ${cmdName} (was ${existing})`);
          }
        } else {
          console.log(`  Warning: overwriting non-symlink file at ${link}`);
        }
        fs.unlinkSync(link);
      }
    } catch {
      // lstat throws ENOENT if nothing exists — that's fine
    }

    // Create symlink
    fs.symlinkSync(target, link);
    result[cmdName] = link;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Remove bin symlinks previously created for a component.
 *
 * @param {object} binEntries - From components.json, e.g. { "zylos-browser": "/home/.../bin/zylos-browser" }
 */
export function unlinkBins(binEntries) {
  if (!binEntries || typeof binEntries !== 'object') return;

  for (const [, linkPath] of Object.entries(binEntries)) {
    try {
      // Only remove if it's actually a symlink (safety check)
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      }
    } catch {
      // Symlink already gone — fine
    }
  }
}
