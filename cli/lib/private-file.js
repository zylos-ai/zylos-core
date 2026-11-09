/**
 * Owner-only files.
 *
 * Files that hold credentials (API keys, tokens) or may carry them are written
 * readable by the owner only, both when they are created and when an existing
 * file is rewritten. Backups of such files get the same mode.
 *
 * Tightening is best effort: a file that cannot be restricted (foreign-owned,
 * or a filesystem without POSIX modes) keeps its own permissions and is still
 * written when it is writable. checkPrivateFile reads the mode back to report
 * the outcome.
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
function tightenPrivateFile(file) {
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
 * The open descriptor is restricted before any content is written, so new
 * content never sits in a file other users can read.
 *
 * @param {string} file
 * @param {string|Uint8Array} content
 * @param {{flag?: 'w'|'a'}} [options] - 'a' appends instead of replacing
 */
export function writePrivateFile(file, content, { flag = 'w' } = {}) {
  const fd = fs.openSync(file, flag, PRIVATE_FILE_MODE);
  try {
    try {
      fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    } catch {}
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy a file into an owner-only target (backups and restores of private files).
 * The target, new or existing, is restricted before the copy is written.
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
