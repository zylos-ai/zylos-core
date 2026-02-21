/**
 * Three-way merge utility using GNU diff3.
 *
 * Performs text-based three-way merges for upgrade conflict resolution.
 * Falls back gracefully when diff3 is not available.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Check if the diff3 command is available on this system.
 *
 * @returns {boolean}
 */
export function isDiff3Available() {
  try {
    execFileSync('diff3', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Perform a three-way merge using diff3.
 *
 * @param {string} baseContent  - Common ancestor (original installed version)
 * @param {string} localContent - User's modified version
 * @param {string} newContent   - Upgrade's new version
 * @returns {{ clean: boolean, content: string }}
 *   clean=true: merge succeeded with no conflicts, content is the merged result
 *   clean=false: merge has conflict markers, content contains <<<<<<< markers
 */
export function merge3(baseContent, localContent, newContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-merge-'));

  const basePath = path.join(tmpDir, 'base');
  const localPath = path.join(tmpDir, 'local');
  const newPath = path.join(tmpDir, 'new');

  try {
    fs.writeFileSync(basePath, baseContent);
    fs.writeFileSync(localPath, localContent);
    fs.writeFileSync(newPath, newContent);

    // diff3 -m: merge mode, outputs merged content
    // Exit codes: 0 = clean merge, 1 = conflicts, 2 = error
    const result = execFileSync('diff3', ['-m', localPath, basePath, newPath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { clean: true, content: result };
  } catch (err) {
    // Exit code 1: conflicts exist, but stdout still has the merged content with markers
    if (err.status === 1 && err.stdout) {
      return { clean: false, content: err.stdout };
    }
    // Exit code 2 or other error: diff3 failed entirely
    throw new Error(`diff3 failed: ${err.stderr || err.message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Perform a three-way merge from file paths.
 *
 * @param {string} basePath  - Path to common ancestor file
 * @param {string} localPath - Path to user's modified file
 * @param {string} newPath   - Path to upgrade's new file
 * @returns {{ clean: boolean, content: string }}
 */
export function merge3Files(basePath, localPath, newPath) {
  const baseContent = fs.readFileSync(basePath, 'utf8');
  const localContent = fs.readFileSync(localPath, 'utf8');
  const newContent = fs.readFileSync(newPath, 'utf8');
  return merge3(baseContent, localContent, newContent);
}
