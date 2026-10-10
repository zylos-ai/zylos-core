import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { ZYLOS_DIR } from './config.js';

const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');

// Preserve the saved startup list while an upgrade owns service isolation.
// This uses files only: C4 may be unavailable during recovery.
export function savePm2ProcessList({
  root = ZYLOS_DIR,
  save = () => execSync('pm2 save', {stdio:'pipe'}),
  log = console.warn,
} = {}) {
  let active = false;
  try {
    if (maintenance.hasRecoveryMaterials(root)) {
      const discovery = maintenance.discover(root);
      active = !!discovery.marker || discovery.candidates.length > 0 || discovery.diagnostics.length > 0;
    }
  } catch { active = true; }
  if (active) {
    log('Skipped PM2 save: upgrade recovery materials are active or cannot be safely classified; preserving the saved startup list.');
    return false;
  }
  save();
  return true;
}
