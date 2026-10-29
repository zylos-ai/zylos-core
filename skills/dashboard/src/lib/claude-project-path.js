import fs from 'node:fs';
export function claudeProjectSlug(directory) {
  return fs.realpathSync(directory).replace(/[^a-zA-Z0-9]/g, '-');
}
