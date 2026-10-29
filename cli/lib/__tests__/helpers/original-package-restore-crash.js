import fs from 'node:fs';
import path from 'node:path';

const boundary = process.env.ZYLOS_TEST_RESTORE_CRASH_BOUNDARY;
const installedRoot = path.resolve(process.env.ZYLOS_TEST_RESTORE_INSTALLED_ROOT || '.');
const binDir = path.resolve(process.env.ZYLOS_TEST_RESTORE_BIN_DIR || '.');
const marker = process.env.ZYLOS_TEST_RESTORE_CRASH_MARKER;

function terminate() {
  fs.writeFileSync(marker, `${boundary}\n`);
  process.kill(process.pid, 'SIGKILL');
}

if (boundary === 'copying') {
  const copy = fs.cpSync;
  fs.cpSync = (source, destination, options = {}) => {
    if (path.resolve(destination) !== installedRoot) return copy(source, destination, options);
    let accepted = 0;
    const filter = options.filter;
    return copy(source, destination, {
      ...options,
      filter(sourceFile, destinationFile) {
        if (filter && !filter(sourceFile, destinationFile)) return false;
        accepted += 1;
        if (accepted === 8) terminate();
        return true;
      },
    });
  };
} else if (boundary === 'before-bin-repair') {
  const symlink = fs.symlinkSync;
  fs.symlinkSync = (target, destination, ...args) => {
    if (path.dirname(path.resolve(destination)) === binDir) terminate();
    return symlink(target, destination, ...args);
  };
} else {
  throw Error(`Unknown restore crash boundary: ${boundary}`);
}
