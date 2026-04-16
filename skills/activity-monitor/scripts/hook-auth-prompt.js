#!/usr/bin/env node

/**
 * Auth Prompt Hook — logs PermissionRequest events and optionally auto-approves
 * by sending an Enter keystroke via the C4 control channel.
 *
 * Registered as a PermissionRequest hook. Claude Code fires this only
 * when a tool call requires user permission (not for auto-allowed tools).
 *
 * Auto-approve: when config.auto_approve_permission is true (default),
 * enqueues a [KEYSTROKE]Enter control at priority 0 with bypass-state
 * and 1s delay. The C4 dispatcher sends the Enter key to auto-confirm.
 *
 * Log file: ~/zylos/activity-monitor/hook-timing.log (shared with other hooks)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const ZYLOS_DIR = path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'hook-timing.log');
const CONFIG_FILE = path.join(ZYLOS_DIR, '.zylos', 'config.json');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
const AUTO_APPROVE_AVAILABLE_IN_SEC = 1;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    return; // malformed input, skip
  }

  const tool = hookData.tool_name || '(unknown)';
  const inputKeys = hookData.tool_input ? Object.keys(hookData.tool_input).join(',') : '';
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] hook=auth-prompt event=PermissionRequest tool=${tool} input_keys=[${inputKeys}]\n`;

  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // best-effort — don't crash hook pipeline
  }

  // Auto-approve: enqueue Enter keystroke via C4 control channel.
  // Claude-only — Codex runtime has no permission prompt UI.
  const config = readConfig();
  const autoApprove = config.auto_approve_permission !== false; // default: true
  const runtime = config.runtime || 'claude';

  if (autoApprove && runtime === 'claude') {
    try {
      execFileSync('node', [
        C4_CONTROL, 'enqueue',
        '--content', '[KEYSTROKE]Enter',
        '--priority', '0',
        '--bypass-state',
        '--available-in', String(AUTO_APPROVE_AVAILABLE_IN_SEC),
        '--no-ack-suffix'
      ], { stdio: 'pipe', timeout: 5000 });
    } catch {
      // best-effort — don't block permission flow
    }
  }
}

main().catch(() => {});
