#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getClaudePid } from './claude-pid.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const FOREGROUND_SESSION_FILE = path.join(MONITOR_DIR, 'foreground-session.json');

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function handleSessionForeground(payload, {
  observedAt = Date.now(),
  claudePid = getClaudePid()
} = {}) {
  const sessionId = payload?.session_id || process.env.CLAUDE_SESSION_ID || null;
  if (!sessionId) return null;

  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }

  const record = {
    version: 1,
    session_id: sessionId,
    claude_pid: claudePid,
    source: 'session_start',
    session_start_source: payload?.source || null,
    observed_at: observedAt
  };
  atomicWriteJson(FOREGROUND_SESSION_FILE, record);
  return record;
}

if (process.env.SESSION_FOREGROUND_DISABLE_MAIN !== '1') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input || '{}');
      handleSessionForeground(payload);
    } catch {
      // Best-effort.
    }
  });
}
