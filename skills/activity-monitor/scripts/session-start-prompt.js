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

const startMs = Date.now();
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
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
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(input);
        resolve(data.source || null);
      } catch {
        resolve(null);
      }
    });
    // If stdin is already closed or empty, resolve after a short timeout
    setTimeout(() => resolve(null), 500);
  });
}

const prompt = [
  'reply to your human partner if they are waiting for your reply,',
  'then continue your ongoing tasks using the startup memory and C4 context already injected in this session,',
  'and do not query c4.db for recent conversations unless explicitly required.'
].join(' ');

async function main() {
  const source = await readStdinSource();
  const hookName = source
    ? `session-start-prompt[${source}]`
    : 'session-start-prompt';

  try {
    execFileSync('node', [
      C4_CONTROL, 'enqueue',
      '--content', prompt,
      '--priority', '2',
      '--no-ack-suffix'
    ], { stdio: 'pipe' });
  } catch {
    // Silently fail — session still starts even if enqueue fails
  } finally {
    await logHookTimingSafe(hookName, Date.now() - startMs);
  }
}

main().catch(() => {
  // Best-effort.
});
