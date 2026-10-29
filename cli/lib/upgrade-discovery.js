import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');

// Execute only the recovery closure frozen by the interrupted transaction.
export function recoverBeforeUpgrade(root, deps = {}) {
  const m = deps.maintenance ?? maintenance;
  const found = m.discover(root);
  if (!found.candidates.length && !found.diagnostics.length && !found.marker) return {active:false};
  const reject = (message, code = 'UPGRADE_RECOVERY_REQUIRED') => {
    throw Object.assign(new Error(message), {code, recovery_required:true, persisted:[],
      next:'Run zylos recovery status, then zylos recovery resume; preserve ambiguous materials for inspection.'});
  };
  if (found.diagnostics.length || found.candidates.length !== 1) reject('Upgrade recovery materials are ambiguous; preserve them for inspection.');
  if (!m.canRecognizeProcesses()) reject('Process identity cannot be verified; interrupted upgrade requires manual recovery.', 'MANUAL_RECOVERY_REQUIRED');
  const {dir, journal} = found.candidates[0];
  const controller = path.join(dir, 'controller.json');
  if (fs.existsSync(controller) && m.alive(m.read(controller))) reject('An upgrade controller is still running.');
  try {m.validateRecoveryFiles(dir, journal);}
  catch(error) {reject(error.message);}
  const child = (deps.spawn ?? spawnSync)(process.execPath, [path.join(dir, 'runner.cjs'), 'resume', '--transaction-dir', dir],
    {encoding:'utf8', env:{...process.env}, maxBuffer:4*1024*1024});
  if (child.error) reject(child.error.message);
  let result;
  try {result = JSON.parse(child.stdout);} catch {reject('Transaction recovery returned an invalid result.');}
  if (child.status !== 0 || result.recovery_required) reject(result.error || result.reason || 'Transaction recovery did not complete.');
  const after = m.discover(root);
  if (after.candidates.length || after.diagnostics.length || after.marker) reject('Transaction recovery still requires attention.');
  return {active:true, result};
}
