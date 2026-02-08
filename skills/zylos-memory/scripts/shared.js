/**
 * Shared utilities for zylos-memory scripts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

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

export function parseEnvValue(raw) {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Load TZ from ~/zylos/.env and return it.
 * Side effect: sets process.env.TZ, which changes Date behavior process-wide.
 * @returns {string|null} timezone string or null
 */
export function loadTimezoneFromEnv() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const envText = fs.readFileSync(envPath, 'utf8');
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const idx = trimmed.indexOf('=');
      if (idx < 0) {
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      if (key !== 'TZ') {
        continue;
      }
      const value = parseEnvValue(trimmed.slice(idx + 1));
      if (value) {
        process.env.TZ = value;
        return value;
      }
    }
  } catch {
    // .env may not exist on fresh setups
  }

  return process.env.TZ || null;
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
