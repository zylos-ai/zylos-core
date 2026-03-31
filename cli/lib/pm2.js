import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ZYLOS_DIR } from './config.js';

export function getCoreEcosystemPath() {
  return path.join(ZYLOS_DIR, 'pm2', 'ecosystem.config.cjs');
}

export function createPm2Helpers({
  exec = execSync,
  exists = fs.existsSync,
} = {}) {
  function restartFromEcosystem(names, {
    ecosystemPath = getCoreEcosystemPath(),
    stdio = 'pipe',
    save = false,
  } = {}) {
    if (!ecosystemPath || !exists(ecosystemPath)) {
      throw new Error(`ecosystem config not found: ${ecosystemPath}`);
    }

    for (const name of names) {
      exec(`pm2 start "${ecosystemPath}" --only "${name}" 2>/dev/null`, { stdio });
    }

    // Persist only after every restart succeeded so callers don't save a
    // partially-updated PM2 process list.
    if (save) {
      exec('pm2 save 2>/dev/null', { stdio });
    }
  }

  function restartManagedProcess(name, {
    ecosystemPath,
    stdio = 'pipe',
    save = false,
    fallbackToPlainRestartOnError = false,
  } = {}) {
    if (ecosystemPath && exists(ecosystemPath)) {
      try {
        restartFromEcosystem([name], { ecosystemPath, stdio, save });
        return;
      } catch (err) {
        if (!fallbackToPlainRestartOnError) {
          throw err;
        }
      }
    }

    exec(`pm2 restart "${name}" 2>/dev/null`, { stdio });

    if (save) {
      exec('pm2 save 2>/dev/null', { stdio });
    }
  }

  return { restartFromEcosystem, restartManagedProcess };
}

export const {
  restartFromEcosystem,
  restartManagedProcess,
} = createPm2Helpers();
