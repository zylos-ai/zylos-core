#!/usr/bin/env node
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getClaudePid } from './claude-pid.js';
import { readHealthQuota } from './health-quota.js';
import { matchHealthNoticeText } from './health-notice-match.js';
import { loadCoreModule } from './core-modules.js';
const { appendEvent } = await loadCoreModule('event-log.js');
const { runDirFromEnv, RUN_FILES } = await loadCoreModule('session-group-paths.js');
import { runtimeRoot } from './runtime-generation.js';

const EVENTS = { SessionStart: 'session_start', UserPromptSubmit: 'prompt_submit', StopFailure: 'stop_failure', Stop: 'stop' };
const ERRORS = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'overloaded', 'server_error', 'model_not_found']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;

export function collectHealthHook(payload, { zylosDir = runtimeRoot(), nowMs = Date.now(), pid = getClaudePid(), env = process.env } = {}) {
  if (!payload || payload.agent_id || !EVENTS[payload.hook_event_name]) return null;
  const session = identifier(payload.session_id);
  if (!session || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (payload.hook_event_name === 'StopFailure' && !identifier(payload.error)) return null;
  const location = runDirFromEnv({...env, ZYLOS_DIR:zylosDir});
  const event = { v:1, session_group:location.kind === 'legacy' ? null : (location.sessionGroup || 'origin'), run_id:env.ZYLOS_RUN_ID || null, schema_version: 1, event_id: randomUUID(), source: 'hook', runtime: 'claude',
    type: 'runtime_health', session_id: session, prompt_id: identifier(payload.prompt_id),
    event: EVENTS[payload.hook_event_name], error: payload.hook_event_name === 'StopFailure' ? (ERRORS.has(payload.error) ? payload.error : 'unknown') : null,
    received_at: nowMs, ts: nowMs, claude_pid: pid };
  if (event.event === 'stop_failure') {
    const match = matchHealthNoticeText(payload);
    if (match) event.notice_match = match;
    const quota = readHealthQuota({ identity: event, zylosDir, nowMs });
    if (quota) event.quota = quota;
  }
  appendEvent(path.join(location.dir,RUN_FILES.EVENTS),event);
  return event;
}

export function wakeHealthMonitor({ zylosDir = runtimeRoot(), timeoutMs = 150 } = {}) {
  return new Promise(resolve => {
    const socket = net.createConnection(path.join(zylosDir, 'activity-monitor', 'am.sock'));
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('connect', () => socket.end(`${JSON.stringify({ version: 1, type: 'health_events_ready', requestId: randomUUID() })}\n`));
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.resume();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '', bytes = 0, oversized = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4 * 1024 * 1024) { oversized = true; input = ''; }
    else if (!oversized) input += chunk;
  });
  process.stdin.on('end', async () => {
    try {
      if (oversized) throw new Error('oversized');
      if (collectHealthHook(JSON.parse(input || '{}'))) await wakeHealthMonitor();
    } catch {
      process.stderr.write('Zylos health hook: event could not be persisted; screen fallback remains available.\n');
    }
  });
}
