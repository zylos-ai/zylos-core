/**
 * Shell utilities — lightweight wrappers for common shell operations.
 */

import { execSync } from 'node:child_process';

/**
 * Check whether a command exists on the system PATH.
 *
 * @param {string} cmd - Command name to check
 * @returns {boolean}
 */
export function commandExists(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
