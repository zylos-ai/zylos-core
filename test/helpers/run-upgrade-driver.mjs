/**
 * Child-process driver for the #715 commit-boundary e2e tests: runs the REAL runUpgrade()
 * pipeline in a clean process so the test can control the child environment
 * (ZYLOS_DIR fixture root, PATH-shim npm) — Jest's sandboxed process.env is
 * not inherited by grandchildren, so the pipeline must run outside it.
 *
 * argv: <component> <tempDir> <newVersion>
 * stdout: the runUpgrade() result as JSON
 */
import { runUpgrade } from '../../cli/lib/upgrade.js';
import fs from 'node:fs';

const [component, tempDir, newVersion] = process.argv.slice(2);
const realRename = fs.renameSync;
if (process.env.ZYLOS_TEST_BASELINE_COMMIT_FAIL === '1') {
  fs.renameSync = (src, dest) => {
    if (String(src).endsWith('manifest.json.tmp')) {
      throw new Error('EIO: injected final baseline commit failure');
    }
    return realRename(src, dest);
  };
}
let result;
try {
  result = runUpgrade(component, { tempDir, newVersion, jsonOutput: true });
} finally {
  fs.renameSync = realRename;
}
console.log(JSON.stringify(result));
