import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const invalid = () => Object.assign(new Error('Deletion target must be a real child of its owned root'), {
  code: 'OWNED_TREE_PATH_INVALID',
});

/**
 * Delete one owned tree after a complete, non-mutating access preflight.
 * The root and the path to target cannot follow links. Links inside the tree
 * are leaf entries: unlink the link itself and never inspect its destination.
 * Root must exist; a missing root propagates ENOENT. With a valid root,
 * returns non-directory entries removed, or 0 when the target is missing.
 * Preflight is not atomic. Callers must exclude concurrent writers: replacing
 * a checked directory with a symlink can redirect later path-based unlinks
 * outside the root. These checks do not provide a concurrent-writer sandbox.
 */
export function removeOwnedTree(root, target) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root === path.parse(root).root
      || fs.realpathSync(root) !== root) throw invalid();
  const candidate = path.resolve(target);
  const relative = path.relative(root, candidate);
  const homes = [os.homedir(), os.userInfo().homedir].map(home => {
    try { return fs.realpathSync(home); }
    catch (error) { if (error.code === 'ENOENT') return path.resolve(home); throw error; }
  });
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      || homes.some(home => home === candidate || home.startsWith(candidate + path.sep))) throw invalid();

  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw invalid();
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  // Unlink/rmdir require write and search access on their parent directory.
  // Check every directory up front, including the target's own parent.
  fs.accessSync(path.dirname(candidate), fs.constants.W_OK | fs.constants.X_OK);
  // Finish every lstat/readdir/access before the first unlink/rmdir.
  const pending = [candidate], entries = [];
  let files = 0;
  while (pending.length) {
    const file = pending.pop();
    const stat = fs.lstatSync(file);
    const directory = stat.isDirectory();
    entries.push({ file, directory });
    if (directory) {
      fs.accessSync(file, fs.constants.W_OK | fs.constants.X_OK);
      for (const name of fs.readdirSync(file)) pending.push(path.join(file, name));
    } else files++;
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const { file, directory } = entries[index];
    if (directory) fs.rmdirSync(file);
    else fs.unlinkSync(file);
  }
  return files;
}
