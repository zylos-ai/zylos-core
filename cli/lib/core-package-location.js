import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Publish an instance-local hint only after its comm-bridge skill was synced. */
export function writeCorePackageLocation({ skillDir, packageRoot, fs: io = fs }) {
  const root = io.realpathSync(packageRoot);
  const metadata = JSON.parse(io.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'zylos' || !io.statSync(path.join(root, 'cli/lib/config.js')).isFile()) {
    throw new Error('Core package location requires a zylos package containing cli/lib/config.js');
  }
  const skill = io.lstatSync(skillDir);
  if (!skill.isDirectory() || skill.isSymbolicLink()) throw new Error('Unsafe comm-bridge installation directory');
  const directory = path.join(skillDir, '.zylos');
  io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = io.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe comm-bridge metadata directory');
  const file = path.join(directory, 'core-package.json');
  try {
    const prior = io.lstatSync(file);
    if (!prior.isFile() || prior.isSymbolicLink()) throw new Error('Unsafe Core package location record');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = { v: 1, packageRoot: root };
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  let fd;
  try {
    fd = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(fd, JSON.stringify(record) + '\n');
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return record;
}
