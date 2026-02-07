#!/usr/bin/env node
/**
 * Daily memory commit helper.
 *
 * Creates a local commit for memory/ in ~/zylos if changes exist.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const ENV_PATH = path.join(ZYLOS_DIR, '.env');

function parseEnvValue(raw) {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadTimezone() {
  try {
    const envText = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const idx = trimmed.indexOf('=');
      if (idx < 0) {
        continue;
      }
      if (trimmed.slice(0, idx).trim() === 'TZ') {
        const value = parseEnvValue(trimmed.slice(idx + 1));
        if (value) {
          return value;
        }
      }
    }
  } catch {
    // .env may not exist
  }
  return process.env.TZ || null;
}

function dateInTimeZone(tz) {
  const now = new Date();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(now);

      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;

      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    } catch {
      // fallback below
    }
  }

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function hasMemoryChanges() {
  const output = execFileSync('git', ['status', '--porcelain', '--', 'memory/'], {
    cwd: ZYLOS_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return output.trim().length > 0;
}

function main() {
  try {
    if (!hasMemoryChanges()) {
      console.log('No memory changes to commit.');
      return;
    }

    const tz = loadTimezone();
    const dateStr = dateInTimeZone(tz);
    const message = `memory: daily snapshot ${dateStr}`;

    execFileSync('git', ['add', 'memory/'], {
      cwd: ZYLOS_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const commitOutput = execFileSync('git', ['commit', '-m', message], {
      cwd: ZYLOS_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    process.stdout.write(commitOutput);
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim();
    const detail = stderr || err.message;
    console.error(`daily-commit error: ${detail}`);
    process.exitCode = 1;
  }
}

main();
