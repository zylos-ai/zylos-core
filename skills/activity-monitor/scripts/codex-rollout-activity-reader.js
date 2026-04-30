import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const SQLITE_FILE = path.join(CODEX_DIR, 'state_5.sqlite');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const TAIL_BYTES = 65_536;

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

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function getCallId(event) {
  return event?.payload?.call_id || event?.payload?.callId || null;
}

function isCallStart(event) {
  return event?.type === 'response_item'
    && (event.payload?.type === 'function_call' || event.payload?.type === 'custom_tool_call')
    && getCallId(event);
}

function isCallEnd(event) {
  if (!getCallId(event)) return false;
  if (event?.type === 'response_item') {
    return event.payload?.type === 'function_call_output'
      || event.payload?.type === 'custom_tool_call_output';
  }
  if (event?.type === 'event_msg') {
    return typeof event.payload?.type === 'string' && event.payload.type.endsWith('_end');
  }
  return false;
}

export function parseCodexRolloutActivityFromLines(lines, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(lines) || !lines.length) {
    return { activeCall: null, lastEventAtMs: 0 };
  }

  const activeCalls = new Map();
  let lastEventAtMs = 0;

  for (const rawLine of lines) {
    const line = rawLine?.trim();
    if (!line) continue;

    try {
      const event = JSON.parse(line);
      const timestampMs = parseTimestampMs(event.timestamp);
      if (timestampMs > lastEventAtMs) lastEventAtMs = timestampMs;

      if (isCallStart(event)) {
        const callId = getCallId(event);
        activeCalls.set(callId, {
          callId,
          name: String(event.payload?.name || event.payload?.tool_name || 'unknown'),
          startedAtMs: timestampMs || nowMs,
        });
        continue;
      }

      if (isCallEnd(event)) {
        activeCalls.delete(getCallId(event));
      }
    } catch {
      // Skip malformed or partial lines at the tail boundary.
    }
  }

  let activeCall = null;
  for (const call of activeCalls.values()) {
    if (!activeCall || call.startedAtMs < activeCall.startedAtMs) {
      activeCall = call;
    }
  }

  if (!activeCall) {
    return { activeCall: null, lastEventAtMs };
  }

  return {
    activeCall: {
      ...activeCall,
      ageSeconds: Math.max(0, Math.floor((nowMs - activeCall.startedAtMs) / 1000)),
    },
    lastEventAtMs,
  };
}

export function readCodexRolloutActivityFromActiveRollout({ nowMs = Date.now() } = {}) {
  const rolloutPath = getActiveRolloutPath();
  if (!rolloutPath) return { activeCall: null, lastEventAtMs: 0 };

  try {
    return parseCodexRolloutActivityFromLines(readTailLines(rolloutPath), { nowMs });
  } catch {
    return { activeCall: null, lastEventAtMs: 0 };
  }
}
