import path from 'node:path';
import {createRequire} from 'node:module';
import {ZYLOS_DIR} from '../lib/config.js';
import {discoverUpgradeContext} from '../lib/runtime/upgrade-context.js';
const require = createRequire(import.meta.url);

export async function recoveryCommand(args, {root = ZYLOS_DIR} = {}) {
  const sub = args[0] || 'status';
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: zylos recovery status | resume\nRecovery uses the existing boot chain and the stable file-only bootstrap.');
    return;
  }
  if (sub === 'configure' || sub === 'verify') {
    throw Error('Dedicated recovery supervisor configuration and verification have been removed. Use the existing PM2/activity-monitor boot chain; zylos recovery status and resume remain available.');
  }
  if (!['status', 'resume'].includes(sub)) throw Error('unknown recovery command; use status or resume');
  const context = discoverUpgradeContext(root);
  if (!context.active || (sub === 'status' && context.recovery_required)) {
    console.log(JSON.stringify(context, null, 2));
    return;
  }
  if (context.recovery_required) {
    console.log(JSON.stringify(context, null, 2));
    process.exitCode = 1;
    return;
  }
  const entry = path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs');
  const result = require(entry).bootstrap(root, {status: sub === 'status', once: sub === 'resume'});
  console.log(JSON.stringify(result, null, 2));
  if (result.recovery_required) process.exitCode = 1;
}
