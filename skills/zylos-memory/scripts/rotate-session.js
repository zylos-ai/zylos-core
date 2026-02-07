#!/usr/bin/env node
/**
 * Rotate session log at day boundary.
 *
 * Reads TZ from ~/zylos/.env, compares current.md header date to today's date,
 * rotates to YYYY-MM-DD.md when needed, then creates a fresh current.md.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = path.join(os.homedir(), 'zylos');
const ENV_PATH = path.join(ZYLOS_DIR, '.env');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const CURRENT_FILE = path.join(SESSIONS_DIR, 'current.md');

function parseEnvValue(raw) {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadTimezoneFromEnv() {
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

function dateInTimeZone(date, tz) {
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

function findHeaderDate(text) {
  const match = text.match(/^# Session Log:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
  return match ? match[1] : null;
}

function resolveArchivePath(baseDate) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(baseDate) ? baseDate : dateInTimeZone(new Date(), process.env.TZ || null);
  let candidate = path.join(SESSIONS_DIR, `${safeDate}.md`);

  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  let counter = 1;
  while (true) {
    candidate = path.join(SESSIONS_DIR, `${safeDate}-${counter}.md`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}

function writeFreshCurrent(today) {
  const header = `# Session Log: ${today}\n\n`;
  fs.writeFileSync(CURRENT_FILE, header, 'utf8');
}

function main() {
  const tz = loadTimezoneFromEnv();
  const today = dateInTimeZone(new Date(), tz);

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  if (fs.existsSync(CURRENT_FILE)) {
    const currentContent = fs.readFileSync(CURRENT_FILE, 'utf8');
    const headerDate = findHeaderDate(currentContent);

    if (headerDate === today) {
      console.log('No rotation needed (current.md matches today).');
      return;
    }

    const stat = fs.statSync(CURRENT_FILE);
    const fallbackDate = dateInTimeZone(stat.mtime, tz);
    const archiveDate = headerDate || fallbackDate;
    const archivePath = resolveArchivePath(archiveDate);
    fs.renameSync(CURRENT_FILE, archivePath);
    console.log(`Rotated current.md -> ${path.basename(archivePath)}`);
  }

  writeFreshCurrent(today);
  console.log(`Created fresh current.md for ${today}`);
}

main();
