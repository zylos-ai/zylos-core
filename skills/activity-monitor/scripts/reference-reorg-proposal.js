import fs from 'node:fs';
import path from 'node:path';

/** Check whether an old reference file remains at its original path. */
export function prepareReferenceReorg({ root, io = fs }) {
  const reference = path.join(root, 'memory', 'reference');
  const oldExists = name => {
    try { io.statSync(path.join(reference, name)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return oldExists('projects.md') || oldExists('decisions.md');
}
