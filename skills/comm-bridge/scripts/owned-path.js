import fs from 'node:fs';
import path from 'node:path';

/** Resolve an exact owned child path without following any symlink component. */
export function ownedPath(base, target, invalid = () => Object.assign(new Error('Deletion path is outside its owned directory or follows a symbolic link'), { code: 'GROUP_DELETE_PATH_INVALID' })) {
  const root = path.resolve(base), candidate = path.resolve(target);
  if (candidate === root || !candidate.startsWith(root + path.sep)) throw invalid();
  let existing = root;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (fs.realpathSync(existing) !== existing) throw invalid();
  let current = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw invalid(); }
    catch (cause) { if (cause.code === 'ENOENT') return candidate; throw cause; }
  }
  return candidate;
}
