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

const prompt = [
  'reply to your human partner if they are waiting your reply,',
  'and continue your work if you have ongoing task according to the previous conversations.'
].join(' ');

async function main() {
  try {
    execFileSync('node', [
      C4_CONTROL, 'enqueue',
      '--content', prompt,
      '--priority', '2',
      '--ack-deadline', '120'
    ], { stdio: 'pipe' });
  } catch {
    // Silently fail — session still starts even if enqueue fails
  } finally {
    await logHookTimingSafe('session-start-prompt', Date.now() - startMs);
  }
}

main().catch(() => {
  // Best-effort.
});
