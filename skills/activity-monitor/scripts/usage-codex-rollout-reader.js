import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const SQLITE_FILE = path.join(CODEX_DIR, 'state_5.sqlite');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const TAIL_BYTES = 65_536;

function formatResetTime(epochSeconds) {
  if (!epochSeconds) return null;

  try {
    const resetAt = new Date(epochSeconds * 1000);
    const now = new Date();
    const sameDay =
      resetAt.getFullYear() === now.getFullYear() &&
      resetAt.getMonth() === now.getMonth() &&
      resetAt.getDate() === now.getDate();

    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(resetAt);

    if (sameDay) return time;

    const date = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short'
    }).format(resetAt);

    return `${time} on ${date}`;
  } catch {
    return null;
  }
}

function readTailLines(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.size) return [];

  const readBytes = Math.min(TAIL_BYTES, stat.size);
  const offset = stat.size - readBytes;
  const buf = Buffer.alloc(readBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, readBytes, offset);
  } finally {
    fs.closeSync(fd);
  }

  return buf.toString('utf8').split('\n');
}

function getActiveRolloutPath() {
  try {
    const sql = [
      'SELECT rollout_path FROM threads',
      'WHERE archived = 0',
      'ORDER BY updated_at DESC',
      'LIMIT 1;'
    ].join(' ');
    const out = execFileSync('sqlite3', [SQLITE_FILE, sql], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    }).trim();
    if (out) return out;
  } catch {
    // Fall back to filesystem scan when sqlite3 is unavailable.
  }

  try {
    let bestPath = null;
    let bestMtime = 0;

    for (const year of fs.readdirSync(SESSIONS_DIR)) {
      const yearDir = path.join(SESSIONS_DIR, year);
      for (const month of fs.readdirSync(yearDir)) {
        const monthDir = path.join(yearDir, month);
        for (const day of fs.readdirSync(monthDir)) {
          const dayDir = path.join(monthDir, day);
          for (const file of fs.readdirSync(dayDir)) {
            if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
            const fullPath = path.join(dayDir, file);
            const mtimeMs = fs.statSync(fullPath).mtimeMs;
            if (mtimeMs > bestMtime) {
              bestMtime = mtimeMs;
              bestPath = fullPath;
            }
          }
        }
      }
    }

    return bestPath;
  } catch {
    return null;
  }
}

export function parseCodexUsageFromRolloutLines(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;

    try {
      const event = JSON.parse(line);
      if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;

      const rateLimits = event.payload?.rate_limits;
      const primary = rateLimits?.primary;
      const secondary = rateLimits?.secondary;
      if (!primary && !secondary) continue;

      const fiveHourPercent = primary?.used_percent ?? null;
      const weeklyAllPercent = secondary?.used_percent ?? null;

      return {
        sessionPercent: fiveHourPercent,
        sessionResets: formatResetTime(primary?.resets_at ?? null),
        fiveHourPercent,
        fiveHourResets: formatResetTime(primary?.resets_at ?? null),
        weeklyAllPercent,
        weeklyAllResets: formatResetTime(secondary?.resets_at ?? null),
        statusShape: 'rollout'
      };
    } catch {
      // Skip malformed or partial lines at the tail boundary.
    }
  }

  return null;
}

export function readCodexUsageFromActiveRollout() {
  const rolloutPath = getActiveRolloutPath();
  if (!rolloutPath) return null;

  try {
    return parseCodexUsageFromRolloutLines(readTailLines(rolloutPath));
  } catch {
    return null;
  }
}
