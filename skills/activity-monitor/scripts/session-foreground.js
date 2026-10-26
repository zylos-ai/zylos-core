#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapScope } from './bootstrap-scope.js';
import { isSubsession, readBootstrapIdentity } from './bootstrap-identity.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const FOREGROUND_SESSION_FILE = path.join(MONITOR_DIR, 'foreground-session.json');

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export async function handleSessionForeground(payload, {
  observedAt = Date.now(),
  env = process.env,
  scopeReader = bootstrapScope,
  identityReader = readBootstrapIdentity,
} = {}) {
  const sessionId = payload?.session_id;
  if (!sessionId) return null;
  if (isSubsession(payload) || env.ZYLOS_RUN_ID) return null;
  const scope = await scopeReader(env);
  const identity = await identityReader(scope, { env });

  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }

  const record = {
    version: 1,
    session_id: sessionId,
    claude_pid: identity.runtimePid,
    runtime: identity.runtime,
    source: 'session_start',
    session_start_source: payload?.source || null,
    observed_at: observedAt
  };
  atomicWriteJson(FOREGROUND_SESSION_FILE, record);
  return record;
}

function runCli() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', async () => {
    try {
      const payload = JSON.parse(input || '{}');
      await handleSessionForeground(payload);
    } catch {
      // Best-effort.
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
