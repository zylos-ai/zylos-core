/**
 * The instance time zone: the agent's `.env` TZ, which the server reports with its state. Every date and time the
 * Dashboard shows is written in it, never in the browser's zone; while it is unknown (an older instance, or a TZ the
 * server could not read) times read in UTC.
 */
let current = null;
const formats = new Map();

function usable(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Records the zone the server reported; anything unusable reads as unknown. */
export function setInstanceZone(zone) {
  current = usable(zone) ? zone : null;
}

/** The zone times are written in: the instance zone, or UTC while it is unknown. */
export function instanceZone(zone = current) {
  return usable(zone) ? zone : 'UTC';
}

function formatter(locale, options, zone) {
  const key = JSON.stringify([locale ?? null, options, zone]);
  let format = formats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale || undefined, { ...options, timeZone: zone });
    } catch {
      format = new Intl.DateTimeFormat(undefined, { ...options, timeZone: zone });
    }
    formats.set(key, format);
  }
  return format;
}

/**
 * `value` (a Date or epoch milliseconds) written with Intl `options` in the instance zone, or in `timeZone` when the
 * caller has its own report of it. Without options the full date and time are written.
 */
export function formatZoned(value, locale, options, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const fields = options && Object.keys(options).length ? options
    : { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
  return formatter(locale, fields, instanceZone(timeZone)).format(date);
}

/** Calendar day (YYYY-MM-DD) of `value` in the instance zone, for "same day" comparisons. */
export function zonedDay(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = {};
  for (const { type, value: part } of formatter('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' },
    instanceZone(timeZone)).formatToParts(date)) parts[type] = part;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function wallParts(value, zone) {
  const parts = {};
  for (const { type, value: part } of formatter('en-US', { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric' }, zone).formatToParts(new Date(value))) {
    if (type !== 'literal') parts[type] = Number(part);
  }
  return parts;
}

const pad = value => String(value).padStart(2, '0');

/** `YYYY-MM-DDTHH:MM` wall time of `value` in the instance zone, as a datetime-local input shows it. */
export function zonedInputValue(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const at = wallParts(date.getTime(), instanceZone(timeZone));
  return `${at.year}-${pad(at.month)}-${pad(at.day)}T${pad(at.hour)}:${pad(at.minute)}`;
}

/** Epoch milliseconds of a datetime-local `YYYY-MM-DDTHH:MM[:SS]` read as wall time in the instance zone; NaN if invalid. */
export function instantFromInput(local, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(local ?? ''));
  if (!match) return NaN;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number), second = match[6] === undefined ? 0 : Number(match[6]);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second), check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return NaN;
  const zone = instanceZone(timeZone);
  const offset = at => {
    const p = wallParts(at, zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  let shift = offset(wall);
  shift = offset(wall - shift);
  return wall - shift;
}
