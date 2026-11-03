#!/usr/bin/env node
/**
 * C4 Communication Bridge - Fetch Conversations
 * Returns checkpoint summary + conversations.
 *
 * Usage:
 *   node c4-fetch.js --unsummarized           Fetch all unsummarized conversations
 *   node c4-fetch.js --begin <id> --end <id>  Fetch conversations in a specific range
 *   node c4-fetch.js --since <time>           Fetch conversations from a point in time
 */

import {
  getLastCheckpoint,
  getUnsummarizedRange,
  getConversationsByRange,
  getConversationsSince,
  formatConversations,
  close
} from './c4-db.js';

const DURATION_UNITS_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const DURATION_PATTERN = /^(\d+)([mhd])$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function usage() {
  console.error('Usage:\n  c4-fetch.js --unsummarized\n  c4-fetch.js --begin <id> --end <id>\n  c4-fetch.js --since <duration|datetime>');
  process.exit(1);
}

/**
 * Format a Date as UTC 'YYYY-MM-DD HH:MM:SS', the format of the timestamp column.
 */
function toDbTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a --since value into a UTC timestamp string.
 * Accepts a relative duration (30m, 6h, 1d) or a datetime (YYYY-MM-DD,
 * YYYY-MM-DD HH:MM[:SS[.sss]], optionally with T, Z or a ±HH:MM offset). A
 * datetime without an offset is UTC, like the timestamps c4-fetch prints.
 * Fractional seconds are dropped, as the timestamp column has none.
 * @returns {string|null} - timestamp, or null when the value is invalid
 */
function parseSince(value) {
  const duration = DURATION_PATTERN.exec(value);
  if (duration) {
    const start = new Date(Date.now() - Number(duration[1]) * DURATION_UNITS_MS[duration[2]]);
    // Durations reaching before year 0000 do not fit the timestamp format.
    return start.getUTCFullYear() >= 0 ? toDbTimestamp(start) : null;
  }

  const datetime = DATETIME_PATTERN.exec(value);
  if (!datetime) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', offset = 'Z'] = datetime;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  // Date.UTC rolls over out-of-range fields (Feb 30 -> Mar 2); reject those.
  if (Number.isNaN(utcMs) || new Date(utcMs).toISOString().slice(0, 19) !== local) return null;

  let offsetMs = 0;
  if (offset !== 'Z') {
    const sign = offset[0] === '-' ? -1 : 1;
    const digits = offset.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutes = Number(digits.slice(2));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  }
  return toDbTimestamp(new Date(utcMs - offsetMs));
}

function printConversations(label, conversations) {
  const checkpoint = getLastCheckpoint();
  const lines = [];

  if (checkpoint?.summary) {
    lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
    lines.push('');
  }

  lines.push(`[Conversations] (${label})`);

  if (conversations.length === 0) {
    lines.push('No conversations in this range.');
  } else {
    lines.push(formatConversations(conversations));
  }

  console.log(lines.join('\n'));
}

function outputConversations(beginId, endId) {
  printConversations(`id ${beginId} ~ ${endId}`, getConversationsByRange(beginId, endId));
}

function outputConversationsSince(since) {
  const conversations = getConversationsSince(since);
  // Rows come in timestamp order; report the full id span for --begin/--end.
  let minId = Infinity;
  let maxId = -Infinity;
  for (const { id } of conversations) {
    minId = Math.min(minId, id);
    maxId = Math.max(maxId, id);
  }
  const label = conversations.length === 0
    ? `since ${since} UTC`
    : `since ${since} UTC, id ${minId} ~ ${maxId}`;
  printConversations(label, conversations);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--since') && args.includes('--unsummarized')) {
    usage();
  }

  if (args.includes('--unsummarized')) {
    try {
      const range = getUnsummarizedRange();
      if (!range || range.count === 0) {
        console.log('No unsummarized conversations.');
        return;
      }
      console.log(`[Unsummarized Range] end_id=${range.end_id} count=${range.count}`);
      outputConversations(range.begin_id, range.end_id);
    } catch (err) {
      console.error(`Error fetching unsummarized conversations: ${err.stack}`);
      process.exit(1);
    } finally {
      close();
    }
    return;
  }

  const sinceIndex = args.indexOf('--since');
  if (sinceIndex !== -1) {
    const since = parseSince(args[sinceIndex + 1] ?? '');
    if (since == null || args.includes('--begin') || args.includes('--end')) {
      usage();
    }
    try {
      outputConversationsSince(since);
    } catch (err) {
      console.error(`Error fetching conversations: ${err.stack}`);
      process.exit(1);
    } finally {
      close();
    }
    return;
  }

  let beginId = null;
  let endId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--begin') {
      beginId = parseInt(args[++i]);
    } else if (args[i] === '--end') {
      endId = parseInt(args[++i]);
    }
  }

  if (beginId == null || endId == null || isNaN(beginId) || isNaN(endId)) {
    usage();
  }

  try {
    outputConversations(beginId, endId);
  } catch (err) {
    console.error(`Error fetching conversations: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
  }
}

main();
