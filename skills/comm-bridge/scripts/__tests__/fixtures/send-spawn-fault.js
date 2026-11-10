import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// Loaded only in one test-owned CLI process, before its real product imports.
const target = process.env.C4_TEST_SPAWN_TARGET;
const fault = process.env.C4_TEST_SPAWN_FAULT;
const root = process.env.ZYLOS_DIR;
assert.ok(path.isAbsolute(target));
assert.ok(['EACCES', 'ENOENT', 'deleted'].includes(fault));
assert.ok(target.startsWith(root + path.sep));
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args?.[0] !== target) return originalSpawn(command, args, options);
  assert.equal(command, process.execPath, 'component uses the current absolute Node executable');
  if (fault === 'deleted') {
    fs.unlinkSync(target);
    return originalSpawn(command, args, options);
  }
  // Native spawn supplies the real asynchronous EACCES/ENOENT error event.
  return originalSpawn(path.join(root, 'bin', fault === 'EACCES' ? 'not-executable' : 'absent'), args, options);
};
syncBuiltinESMExports();
