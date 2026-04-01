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
 * Log file: ~/zylos/activity-monitor/auth-prompt.log
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_FILE = path.join(os.homedir(), 'zylos', 'activity-monitor', 'auth-prompt.log');

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

  const entry = {
    ts: new Date().toISOString(),
    event: hookData.hook_event_name || 'PermissionRequest',
    tool: hookData.tool_name || '(unknown)',
    input_keys: hookData.tool_input ? Object.keys(hookData.tool_input) : [],
    session_id: hookData.session_id || null,
  };

  const line = JSON.stringify(entry) + '\n';

  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // best-effort — don't crash hook pipeline
  }
}

main().catch(() => {});
