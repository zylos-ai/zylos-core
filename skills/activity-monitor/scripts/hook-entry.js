#!/usr/bin/env node
/**
 * Single entry for every runtime hook and statusLine command that zylos
 * installs: `exec node hook-entry.js <target script> [args...]`.
 *
 * Only the run's pane main process may act through these commands. Child
 * runtimes started inside a session (an upgrade evaluation, an agent's
 * `claude -p` or `codex exec`) inherit the run variables and fire the same
 * hooks; they are refused here before any target code runs:
 *
 * - main process: the target runs in this same process (no second node start).
 * - determinably another process: nothing runs and nothing is printed. Its
 *   SessionStart only appends one cost record (session id, transcript path,
 *   its own runtime, group and run) so the Dashboard can still count its tokens.
 * - undetermined (missing record, unreadable process data): the target runs as
 *   before and one line goes to the hook error log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHookTrigger, readProcessInfo } from './claude-pid.js';
import { classifyHookProcess, childRuntimeOf } from './pane-process.js';
import { isMainModule } from './is-main-module.js';
import { loadCoreModule } from './core-modules.js';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export function hookName(target, args = []) {
  const shard = args.indexOf('--shard');
  const base = path.basename(target);
  return shard >= 0 && args[shard + 1] ? `${base}#${args[shard + 1]}` : base;
}

function configuredRuntime(env) {
  try { return JSON.parse(env.ZYLOS_MODEL_CONFIG).runtime || 'unknown'; }
  catch { return 'unknown'; }
}

async function readPayload(stream) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_PAYLOAD_BYTES) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { return null; }
}

/** The single record a refused child leaves: what the Dashboard needs to count its cost. */
export function childSessionRecord(payload, { env, location, trigger, nowMs }) {
  if (payload?.hook_event_name !== 'SessionStart') return null;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return null;
  const transcript = typeof payload.transcript_path === 'string' && payload.transcript_path ? payload.transcript_path : null;
  const runtime = childRuntimeOf(trigger, transcript);
  if (!runtime || !transcript) return null;
  return {
    v: 1, ts: nowMs, runtime,
    session_group: location.kind === 'legacy' ? null : (location.sessionGroup || 'origin'),
    run_id: env.ZYLOS_RUN_ID || null, session_id: payload.session_id, transcript_path: transcript,
  };
}

export async function runHookEntry(argv = process.argv, {
  env = process.env,
  readTrigger = readHookTrigger,
  readInfo = readProcessInfo,
  stdin = process.stdin,
  nowMs = Date.now,
  importTarget = target => import(pathToFileURL(target).href),
} = {}) {
  const [node, , target, ...args] = argv;
  if (typeof target !== 'string' || !path.isAbsolute(target) || !/\.m?js$/.test(target)) {
    process.stderr.write('[hook-entry] usage: hook-entry.js <absolute target script> [args...]\n');
    process.exitCode = 1;
    return { action: 'invalid' };
  }
  const { runDirFromEnv, hookErrorLogPath, RUN_FILES } = await loadCoreModule('session-group-paths.js');
  let location = null, trigger = null, decision;
  try {
    location = runDirFromEnv(env);
    trigger = readTrigger();
    decision = classifyHookProcess({ env, dir: location.dir, trigger, readInfo });
  } catch (error) {
    decision = { verdict: 'unknown', reason: `error:${error.code || error.message}` };
  }

  if (decision.verdict === 'child') {
    if (path.basename(target) === 'hook-activity.js') {
      try {
        const record = childSessionRecord(await readPayload(stdin), { env, location, trigger, nowMs: nowMs() });
        if (record) {
          const { appendEvent } = await loadCoreModule('event-log.js');
          appendEvent(path.join(location.dir, RUN_FILES.CHILD_SESSIONS), record);
        }
      } catch { /* A lost cost record must never surface in the child or the session. */ }
    }
    return { action: 'refused', decision };
  }

  if (decision.verdict === 'unknown') {
    try {
      const file = hookErrorLogPath(env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date(nowMs()).toISOString()} hook-entry: main process undetermined, hook allowed` +
        ` reason=${decision.reason} pid=${trigger?.pid ?? process.ppid} runtime=${configuredRuntime(env)}` +
        ` hook=${hookName(target, args)} session_group=${JSON.stringify(env.ZYLOS_SESSION_GROUP ?? null)}` +
        ` run_id=${JSON.stringify(env.ZYLOS_RUN_ID || null)}\n`);
    } catch { /* Logging is best effort; the hook still runs. */ }
  }

  // The target keeps its own entry-point check (`isMainModule`) and argument
  // parsing, so it sees exactly the argv of a direct invocation.
  process.argv = [node, target, ...args];
  await importTarget(target);
  return { action: 'ran', decision };
}

if (isMainModule(import.meta.url)) {
  runHookEntry().catch(error => {
    process.stderr.write(`[hook-entry] ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
