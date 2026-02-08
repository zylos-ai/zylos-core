/**
 * Shared utilities for zylos-memory scripts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse } from 'dotenv';

export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
export const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');

export const BUDGETS = {
  'identity.md': 4096,
  'state.md': 4096,
  'references.md': 2048
};

export const REFERENCE_FILES = [
  'reference/decisions.md',
  'reference/projects.md',
  'reference/preferences.md',
  'reference/ideas.md'
];

/**
 * Load TZ from ~/zylos/.env and return it.
 * Side effect: sets process.env.TZ, which changes Date behavior process-wide.
 * @returns {string|null} timezone string or null
 */
export function loadTimezoneFromEnv() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const envText = fs.readFileSync(envPath, 'utf8');
    const env = parse(envText);
    if (env.TZ) {
      process.env.TZ = env.TZ;
      return env.TZ;
    }
  } catch {
    // .env may not exist on fresh setups
  }

  return process.env.TZ || null;
}

const MAX_WALK_DEPTH = 10;

/**
 * Recursively walk a directory and return file metadata.
 * Skips dot-files and limits recursion depth.
 * @param {string} rootDir - Directory to walk
 * @param {string} [prefix=''] - Relative path prefix for output
 * @param {number} [depth=0] - Current recursion depth
 * @returns {Array<{path: string, sizeBytes: number, modifiedAt: string, ageDays: number}>}
 */
export function walkFiles(rootDir, prefix = '', depth = 0) {
  const out = [];

  if (!fs.existsSync(rootDir) || depth > MAX_WALK_DEPTH) {
    return out;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, relPath, depth + 1));
      continue;
    }

    const stat = fs.statSync(fullPath);
    out.push({
      path: relPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ageDays: Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24))
    });
  }

  return out;
}

export function dateInTimeZone(date, tz) {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);

      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;

      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    } catch {
      // Invalid TZ value falls back to local date below
    }
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
