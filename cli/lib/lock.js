/**
 * File-based lock utilities for component upgrades
 * Prevents concurrent upgrades of the same component
 */

const fs = require('fs');
const path = require('path');
const { LOCKS_DIR } = require('./config');

const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Ensure locks directory exists
 */
function ensureLocksDir() {
  if (!fs.existsSync(LOCKS_DIR)) {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
  }
}

/**
 * Get lock file path for a component
 */
function getLockPath(component) {
  return path.join(LOCKS_DIR, `${component}.lock`);
}

/**
 * Check if a process is still running
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a lock for a component
 * @param {string} component - Component name
 * @returns {{ success: boolean, error?: string, existingPid?: number }}
 */
function acquireLock(component) {
  ensureLocksDir();
  const lockPath = getLockPath(component);

  // Check if lock already exists
  if (fs.existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const lockAge = Date.now() - lockData.timestamp;

      // Check if lock is stale (older than timeout or process dead)
      if (lockAge > LOCK_TIMEOUT_MS || !isProcessRunning(lockData.pid)) {
        // Stale lock, remove it
        fs.unlinkSync(lockPath);
      } else {
        // Valid lock exists
        return {
          success: false,
          error: `Component "${component}" is being upgraded by PID ${lockData.pid}`,
          existingPid: lockData.pid,
        };
      }
    } catch {
      // Corrupted lock file, remove it
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }

  // Create new lock
  try {
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
      component,
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2), { flag: 'wx' });
    return { success: true };
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Race condition: another process created the lock
      return {
        success: false,
        error: `Component "${component}" lock acquired by another process`,
      };
    }
    return {
      success: false,
      error: `Failed to create lock: ${err.message}`,
    };
  }
}

/**
 * Release a lock for a component
 * @param {string} component - Component name
 * @returns {{ success: boolean, error?: string }}
 */
function releaseLock(component) {
  const lockPath = getLockPath(component);

  if (!fs.existsSync(lockPath)) {
    return { success: true }; // Already released
  }

  try {
    // Only release if we own the lock
    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lockData.pid !== process.pid) {
      return {
        success: false,
        error: `Lock owned by different process (PID ${lockData.pid})`,
      };
    }

    fs.unlinkSync(lockPath);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Failed to release lock: ${err.message}`,
    };
  }
}

/**
 * Check if a component is currently locked
 * @param {string} component - Component name
 * @returns {{ locked: boolean, pid?: number, age?: number }}
 */
function isLocked(component) {
  const lockPath = getLockPath(component);

  if (!fs.existsSync(lockPath)) {
    return { locked: false };
  }

  try {
    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const lockAge = Date.now() - lockData.timestamp;

    // Check if lock is valid
    if (lockAge > LOCK_TIMEOUT_MS || !isProcessRunning(lockData.pid)) {
      return { locked: false }; // Stale lock
    }

    return {
      locked: true,
      pid: lockData.pid,
      age: lockAge,
    };
  } catch {
    return { locked: false }; // Corrupted lock
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  isLocked,
  LOCK_TIMEOUT_MS,
};
