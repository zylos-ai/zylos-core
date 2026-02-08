/**
 * PM2 service management for components
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Register and start a PM2 service for a component.
 *
 * @param {object} opts
 * @param {string} opts.name - Service name (will be prefixed with "zylos-")
 * @param {string} opts.entry - Entry script path (relative to skillDir)
 * @param {string} opts.skillDir - Component's skill directory
 * @param {'pm2'} opts.type - Service type (only pm2 supported for now)
 * @returns {{ success: boolean, error?: string }}
 */
export function registerService({ name, entry, skillDir, type }) {
  if (type !== 'pm2') {
    return { success: false, error: `Unsupported service type: ${type}. Only "pm2" is supported.` };
  }

  const serviceName = `zylos-${name}`;
  const scriptPath = path.resolve(skillDir, entry);

  if (!fs.existsSync(scriptPath)) {
    return { success: false, error: `Entry script not found: ${scriptPath}` };
  }

  try {
    // Stop existing service if running (ignore errors)
    try {
      execSync(`pm2 delete "${serviceName}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Not running — fine
    }

    // Start service — prefer ecosystem.config.cjs if available
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    if (fs.existsSync(ecosystemPath)) {
      execSync(`pm2 start "${ecosystemPath}"`, {
        stdio: 'pipe',
        timeout: 30000,
      });
    } else {
      execSync(`pm2 start "${scriptPath}" --name "${serviceName}"`, {
        stdio: 'pipe',
        timeout: 30000,
      });
    }

    // Save PM2 process list
    execSync('pm2 save 2>/dev/null', { stdio: 'pipe' });

    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to start service: ${err.message}` };
  }
}
