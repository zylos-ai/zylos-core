/**
 * Owner-only files.
 *
 * Files that hold credentials (API keys, tokens) or may carry them are written
 * readable by the owner only, both when they are created and when an existing
 * file is rewritten. Backups of such files get the same mode.
 *
 * Tightening is best effort: the content is already written, and a read-only
 * or foreign-owned file (or a filesystem without POSIX modes) keeps its own
 * permissions. checkPrivateFile reads the mode back to report the outcome.
 * Symbolic links are followed, so the file a link points to is the one
 * written and tightened.
 */

import fs from 'node:fs';

export const PRIVATE_FILE_MODE = 0o600;

/**
 * Restrict an existing file to owner read/write. Best effort, never throws.
 *
 * @param {string} file
 */
export function tightenPrivateFile(file) {
  try {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch {}
}

function fileMode(file) {
  try {
    const stat = fs.statSync(file);
    return { mode: stat.mode & 0o777, uid: stat.uid };
  } catch {
    return null;
  }
}

/**
 * Write a file, creating it owner-only and tightening an existing one.
 *
 * @param {string} file
 * @param {string|Uint8Array} content
 */
export function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, { mode: PRIVATE_FILE_MODE });
  tightenPrivateFile(file);
}

/**
 * Copy a file into an owner-only target (backups and restores of private files).
 * A new target is created owner-only, so no copy is ever readable by others.
 *
 * @param {string} source
 * @param {string} target
 */
export function copyPrivateFile(source, target) {
  writePrivateFile(target, fs.readFileSync(source));
}

/**
 * Make sure group and other users cannot access a file.
 * A file owned by the current user is tightened to 0600 on the spot; a file
 * owned by someone else is only reported. Missing or unreadable files, and
 * platforms without POSIX permission bits, are not checked.
 *
 * @param {string} file
 * @returns {{ok: boolean, mode: string|null, fixed: boolean, previousMode?: string}}
 */
export function checkPrivateFile(file, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const format = bits => bits.toString(8).padStart(3, '0');
  const before = platform === 'win32' ? null : fileMode(file);
  if (!before) return { ok: true, mode: null, fixed: false };
  if ((before.mode & 0o077) === 0) return { ok: true, mode: format(before.mode), fixed: false };
  if (before.uid === uid) {
    tightenPrivateFile(file);
    const after = fileMode(file);
    if (after && (after.mode & 0o077) === 0) return { ok: true, mode: format(after.mode), fixed: true, previousMode: format(before.mode) };
  }
  return { ok: false, mode: format(before.mode), fixed: false };
}
