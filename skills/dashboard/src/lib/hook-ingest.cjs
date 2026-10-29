#!/usr/bin/env node
// Standalone hook ingest script — invoked by Claude Code hooks.
// No imports from src/. Only Node built-ins. Must exit within 500ms.
'use strict';

// Deadlines are env-overridable so tests on loaded machines can widen them;
// production hooks always run with the defaults.
const EXIT_DEADLINE_MS = Number(process.env.ZYLOS_HOOK_EXIT_MS) || 500;
const POST_TIMEOUT_MS = Number(process.env.ZYLOS_HOOK_POST_TIMEOUT_MS) || 200;

setTimeout(() => process.exit(0), EXIT_DEADLINE_MS);

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_EVENTS = new Set([
  'SessionStart',
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest',
  'SubagentStart', 'SubagentStop'
]);

// ZYLOS_DIR is a platform-level bootstrap locator, not component config
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(require('node:os').homedir(), 'zylos');
const DATA_DIR = path.join(ZYLOS_DIR, 'components', 'dashboard');
const SPOOL_DIR = path.join(DATA_DIR, 'spool');
const SPOOL_PATH = path.join(SPOOL_DIR, 'hook-events.jsonl');

function loadComponentConfig() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const cfg = loadComponentConfig();
const DASHBOARD_PORT = cfg.port || 3470;
const INGEST_TOKEN = cfg.ingestToken || null;
const SPOOL_MAX_BYTES = Number(cfg.spoolMaxBytes) || 10 * 1024 * 1024;

async function main() {
  const stdin = await readStdin();
  if (!stdin) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    process.exit(0);
  }

  const hook_event_name = payload.hook_event_name || payload.event;
  if (!hook_event_name || !ALLOWED_EVENTS.has(hook_event_name)) {
    process.exit(0);
  }

  const ingest_id = randomUUID();
  const received_at = new Date().toISOString();
  const runtime = process.env.ZYLOS_RUNTIME || 'claude';

  const body = JSON.stringify({
    ...payload,
    ingest_id,
    hook_event_name,
    received_at,
    runtime
  });

  const ok = await postToServer(body);
  if (!ok) {
    spool({ ingest_id, received_at, hook_event_name, runtime, data: payload });
  }

  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let timer = setTimeout(() => resolve(chunks.join('')), 200);

    process.stdin.on('data', (chunk) => {
      clearTimeout(timer);
      chunks.push(chunk.toString());
      timer = setTimeout(() => resolve(chunks.join('')), 50);
    });

    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(chunks.join(''));
    });

    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

async function postToServer(body) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);

    const headers = { 'content-type': 'application/json' };
    if (INGEST_TOKEN) headers.authorization = `Bearer ${INGEST_TOKEN}`;

    const resp = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/ingest`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });

    clearTimeout(timeout);
    return resp.status === 200;
  } catch {
    return false;
  }
}

function spool(record) {
  try {
    if (!fs.existsSync(SPOOL_DIR)) {
      fs.mkdirSync(SPOOL_DIR, { recursive: true });
    }

    try {
      const stat = fs.statSync(SPOOL_PATH);
      if (stat.size > SPOOL_MAX_BYTES) return;
    } catch {
      // file doesn't exist yet — OK to write
    }

    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(SPOOL_PATH, line);
  } catch (err) {
    process.stderr.write(`[hook-ingest] spool error: ${err.message}\n`);
  }
}

try {
  main();
} catch {
  process.exit(0);
}
