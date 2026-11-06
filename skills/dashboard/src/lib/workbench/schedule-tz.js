import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TZ_MODULE = new URL('../../../../scheduler/scripts/tz.js', import.meta.url).href;

function sameDirectory(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * The scheduler's tz.js fixes its .env path from ZYLOS_DIR when first imported.
 * When this process would read another installation's .env, report unknown.
 */
export function createScheduleTz({ zylosDir, env = process.env, home = os.homedir(),
  tzModule = TZ_MODULE } = {}) {
  return async function scheduleTz() {
    const envDir = env.ZYLOS_DIR ?? path.join(home, 'zylos');
    if (!sameDirectory(envDir, zylosDir)) return { tz: null, reason: 'tz_unavailable' };
    try {
      const { loadTimezone } = await import(tzModule);
      return { tz: loadTimezone() };
    } catch {
      return { tz: null, reason: 'tz_unavailable' };
    }
  };
}

function offsetMinutes(epochMs, tz) {
  const parts = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  for (const { type, value } of format.formatToParts(new Date(epochMs))) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((wall - Math.floor(epochMs / 1000) * 1000) / 60000);
}

const pad = value => String(value).padStart(2, '0');

/** Converts a form's local `YYYY-MM-DDTHH:MM` in `tz` to an ISO string with its offset. */
export function localToOffsetIso(local, tz) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(local ?? ''));
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    hour > 23 || minute > 59 || second > 59) return null;
  let offset = offsetMinutes(wall, tz);
  offset = offsetMinutes(wall - offset * 60000, tz);
  const epochMs = wall - offset * 60000;
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${pad(second)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return { iso, epoch: Math.floor(epochMs / 1000) };
}

/** Calendar date (YYYY-MM-DD) of an epoch second in `tz`. */
export function dateKey(epochSeconds, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(epochSeconds * 1000));
}
