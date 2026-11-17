/**
 * Shell utilities — lightweight wrappers for common shell operations.
 */

import { execFileSync } from 'node:child_process';

import { execSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Check whether a command exists on the system PATH.
 *
 * @param {string} cmd - Command name to check
 * @returns {boolean}
 */
export function commandExists(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Test whether bwrap can actually create a sandbox.
 * Binary existence is necessary but not sufficient — AppArmor or other
 * kernel restrictions can prevent sandbox creation even when bwrap is installed.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function testBwrapSandbox() {
  if (!commandExists('bwrap')) {
    return { ok: false, error: 'bwrap not installed' };
  }
  try {
    execSync(
      'bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/bin /bin --symlink usr/sbin /sbin --proc /proc --dev /dev --tmpfs /tmp --unshare-all --die-with-parent true',
      { stdio: 'pipe', timeout: 10000 },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString().trim() || 'sandbox creation failed' };
  }
}

/**
 * Check if AppArmor is restricting unprivileged user namespaces.
 * @returns {boolean}
 */
export function isAppArmorRestrictingUserns() {
  try {
    const val = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
    return val === '1';
  } catch {
    return false;
  }
}

/**
 * Check if a bwrap AppArmor profile is already loaded.
 * @returns {boolean}
 */
export function isBwrapAppArmorProfileLoaded() {
  try {
    const profiles = execSync('cat /sys/kernel/security/apparmor/profiles 2>/dev/null', {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return profiles.includes('bwrap');
  } catch {
    try {
      const result = execSync('sudo aa-status 2>/dev/null', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
      });
      return result.includes('bwrap');
    } catch {
      return false;
    }
  }
}

const BWRAP_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

/**
 * Create and load the bwrap AppArmor profile. Requires sudo.
 * Follows the setCaddyCapabilities() pattern: attempt sudo directly,
 * print manual fix command on failure.
 *
 * @returns {boolean} true if profile was created and loaded successfully
 */
export function setupBwrapAppArmor() {
  if (process.platform !== 'linux') return true;

  const profilePath = '/etc/apparmor.d/bwrap';
  const sudo = process.getuid?.() === 0 ? '' : 'sudo ';

  try {
    execSync(`${sudo}tee ${profilePath} > /dev/null`, {
      input: BWRAP_APPARMOR_PROFILE,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    execSync(`${sudo}apparmor_parser -r ${profilePath}`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}
