#!/usr/bin/env node
/**
 * Session start hook: enqueues a startup prompt via control queue
 * that tells Claude to resume work or reply to waiting partners.
 *
 * Delivered as a control message so Claude is actively triggered,
 * not just given passive context.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
const DEFAULT_CHILD_TIMEOUT_MS = 2500;
let diagnosticModule;
let diagnosticLoadAttempted = false;

async function getDiagnosticModule() {
  if (!diagnosticLoadAttempted) {
    diagnosticLoadAttempted = true;
    try {
      diagnosticModule = await import('../../comm-bridge/scripts/c4-diagnostic.js');
    } catch {
      diagnosticModule = null;
    }
  }
  return diagnosticModule;
}

async function logHookTimingSafe(name, durationMs) {
  const module = await getDiagnosticModule();
  if (module?.logHookTiming) {
    module.logHookTiming(name, durationMs);
  }
}

/**
 * Read stdin JSON to extract the hook event source.
 * SessionStart stdin format: {"type":"event","event":"session_start","session_id":"...","source":"startup|resume|clear|compact"}
 */
function readStdinSource() {
  return new Promise((resolve) => {
    let input = '';
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
    };
    const finish = (value) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const onData = chunk => { input += chunk; };
    const onEnd = () => {
      try {
        const data = JSON.parse(input || '{}');
        finish(data.source || null);
      } catch {
        finish(null);
      }
    };
    const timer = setTimeout(() => finish(null), 500);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

const prompt = [
  'reply to your human partner if they are waiting for your reply,',
  'then continue your ongoing tasks using the startup memory and C4 context already injected in this session,',
  'and do not query c4.db for recent conversations unless explicitly required.'
].join(' ');

export function enqueueStartupPrompt(source, {
  execFile = execFileSync,
  controlPath = C4_CONTROL,
  childTimeoutMs = DEFAULT_CHILD_TIMEOUT_MS,
} = {}) {
  execFile('node', [
    controlPath, 'enqueue',
    '--content', prompt,
    '--priority', '2',
    '--no-ack-suffix'
  ], {
    stdio: 'pipe',
    timeout: childTimeoutMs,
    killSignal: 'SIGKILL',
  });
}

async function main() {
  const startMs = Date.now();
  const source = await readStdinSource();
  const hookName = source
    ? `session-start-prompt[${source}]`
    : 'session-start-prompt';

  try {
    enqueueStartupPrompt(source);
  } catch {
    // Silently fail — session still starts even if enqueue fails
  } finally {
    await logHookTimingSafe(hookName, Date.now() - startMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Best-effort.
  });
}
