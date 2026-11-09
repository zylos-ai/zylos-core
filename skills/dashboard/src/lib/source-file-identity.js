import fs from 'node:fs';

/** Recheck at the database writer boundary, after any asynchronous source work. */
export function sameSourceFile(file, identity) {
  try {
    const current = fs.statSync(file);
    return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
