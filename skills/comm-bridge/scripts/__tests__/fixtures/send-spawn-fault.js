import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// Scope the fault to one test-owned component. The real OS still supplies the
// asynchronous error event; product source and send error handling stay intact.
export function installSendSpawnFault({ target, fault, root }) {
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
    return originalSpawn(path.join(root, 'bin', fault === 'EACCES' ? 'not-executable' : 'absent'), args, options);
  };
  syncBuiltinESMExports();
  return () => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); };
}

// Preload mode is used only by a bounded, test-owned CLI child.
if (process.env.C4_TEST_SPAWN_TARGET) installSendSpawnFault({
  target: process.env.C4_TEST_SPAWN_TARGET,
  fault: process.env.C4_TEST_SPAWN_FAULT,
  root: process.env.ZYLOS_DIR,
});
