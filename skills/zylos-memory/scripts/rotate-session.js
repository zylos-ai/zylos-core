#!/usr/bin/env node
/**
 * Migrate a legacy current.md once to a dated session log.
 *
 * Preserve its header date (or mtime) and never create another current.md.
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

export function resolveArchivePath(baseDate, tz) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(baseDate) ? baseDate : dateInTimeZone(new Date(), tz);
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

function main() {
  const tz = loadTimezoneFromEnv();

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  if (fs.existsSync(CURRENT_FILE)) {
    const currentContent = fs.readFileSync(CURRENT_FILE, 'utf8');
    const headerDate = findHeaderDate(currentContent);

    const stat = fs.statSync(CURRENT_FILE);
    const fallbackDate = dateInTimeZone(stat.mtime, tz);
    const archiveDate = headerDate || fallbackDate;
    const archivePath = resolveArchivePath(archiveDate, tz);
    fs.renameSync(CURRENT_FILE, archivePath);
    console.log(`Rotated current.md -> ${path.basename(archivePath)}`);
  }

  // No current.md: migration is already complete; new logs use dated files.
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
