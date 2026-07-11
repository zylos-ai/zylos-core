/**
 * Child-process driver for the #715 R5 e2e tests: runs the REAL runUpgrade()
 * pipeline in a clean process so the test can control the child environment
 * (ZYLOS_DIR fixture root, PATH-shim npm) — Jest's sandboxed process.env is
 * not inherited by grandchildren, so the pipeline must run outside it.
 *
 * argv: <component> <tempDir> <newVersion>
 * stdout: the runUpgrade() result as JSON
 */
import { runUpgrade } from '../../cli/lib/upgrade.js';

const [component, tempDir, newVersion] = process.argv.slice(2);
const result = runUpgrade(component, { tempDir, newVersion, jsonOutput: true });
console.log(JSON.stringify(result));
