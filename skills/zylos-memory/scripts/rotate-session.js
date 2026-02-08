#!/usr/bin/env node
/**
 * Rotate session log at day boundary.
 *
 * Reads TZ from ~/zylos/.env, compares current.md header date to today's date,
 * rotates to YYYY-MM-DD.md when needed, then creates a fresh current.md.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SESSIONS_DIR, loadTimezoneFromEnv, dateInTimeZone } from './shared.js';

const CURRENT_FILE = path.join(SESSIONS_DIR, 'current.md');
const MAX_ARCHIVE_SUFFIX = 100;

export function findHeaderDate(text) {
  const match = text.match(/^# Session Log:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
  return match ? match[1] : null;
}

function resolveArchivePath(baseDate) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(baseDate) ? baseDate : dateInTimeZone(new Date(), process.env.TZ || null);
  let candidate = path.join(SESSIONS_DIR, `${safeDate}.md`);

  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  for (let counter = 1; counter <= MAX_ARCHIVE_SUFFIX; counter++) {
    candidate = path.join(SESSIONS_DIR, `${safeDate}-${counter}.md`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Too many archive files for ${safeDate} (exceeded ${MAX_ARCHIVE_SUFFIX})`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
