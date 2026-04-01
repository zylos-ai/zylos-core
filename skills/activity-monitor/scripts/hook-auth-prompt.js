#!/usr/bin/env node

/**
 * Auth Prompt Hook — logs PermissionRequest events to observe when
 * Claude Code's authorization prompt is triggered.
 *
 * Registered as a PermissionRequest hook. Claude Code fires this only
 * when a tool call requires user permission (not for auto-allowed tools).
 * The script logs the event and exits without output, so Claude Code
 * proceeds with its normal permission flow.
 *
 * Log file: ~/zylos/activity-monitor/hook-timing.log (shared with other hooks)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_FILE = path.join(os.homedir(), 'zylos', 'activity-monitor', 'hook-timing.log');

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
}

main().catch(() => {});
