import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Remove the same entries as launch.sh immediately before a real filesystem
// operation, after removeOwnedTree has already checked the target exists.
export function injectLaunchCleanupRace(t, script, operation) {
  const dir = path.dirname(script.file);
  const original = fs[operation];
  let hits = 0;
  const method = t.mock.method(fs, operation, function (file, ...args) {
    if (hits === 0 && file === (operation === 'unlinkSync' ? script.file : dir)) {
      hits++;
      fs.rmSync(script.file, {force:true});
      if (operation !== 'unlinkSync') fs.rmdirSync(dir);
    }
    return original.call(this, file, ...args);
  });
  return () => {
    method.mock.restore();
    assert.equal(hits, 1, `must reach the ${operation} race`);
    assert.equal(fs.existsSync(dir), false, 'cleanup must leave no temporary directory');
  };
}
