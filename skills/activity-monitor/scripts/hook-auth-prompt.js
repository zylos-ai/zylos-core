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
import { fileURLToPath } from 'node:url';
import { readZylosConfigOrThrow } from '../../comm-bridge/scripts/local-config.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'hook-timing.log');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
const AUTO_APPROVE_AVAILABLE_IN_SEC = 1;

export async function approvePermission(hookData, {
  env = process.env,
  readConfig = readZylosConfigOrThrow,
  scopeReader,
  identityReader,
  exec = execFileSync,
  controlPath = C4_CONTROL,
} = {}) {
  if (!hookData || hookData.agent_id || hookData.agent_type || hookData.is_subagent ||
      hookData.hook_event_name !== 'PermissionRequest' ||
      typeof hookData.session_id !== 'string' || !hookData.session_id || !env.ZYLOS_RUN_ID) {
    return { skipped: true, reason: 'identity_missing' };
  }
  const config = readConfig();
  if (config.auto_approve_permission !== undefined && typeof config.auto_approve_permission !== 'boolean') {
    throw Object.assign(new Error('auto_approve_permission must be boolean'), { code: 'CONFIG_UNREADABLE' });
  }
  if (config.auto_approve_permission === false) return { skipped: true, reason: 'disabled' };
  let launchConfig;
  try { launchConfig = JSON.parse(env.ZYLOS_MODEL_CONFIG); } catch { /* No F1 fallback. */ }
  if (launchConfig?.runtime !== 'claude') return { skipped: true, reason: 'runtime_unconfirmed' };
  scopeReader ??= (await import('./bootstrap-scope.js')).bootstrapScope;
  identityReader ??= (await import('./bootstrap-identity.js')).readBootstrapIdentity;
  const scope = await scopeReader(env);
  const identity = await identityReader(scope, { env });
  if (identity.runtime !== 'claude' || identity.runId !== env.ZYLOS_RUN_ID) {
    return { skipped: true, reason: 'runtime_unconfirmed' };
  }
  exec('node', [
    controlPath, 'enqueue', '--content', '[KEYSTROKE]Enter', '--priority', '0',
    '--bypass-state', '--available-in', String(AUTO_APPROVE_AVAILABLE_IN_SEC), '--no-ack-suffix',
    ...(scope.sessionGroup ? ['--group', scope.sessionGroup] : []),
    '--target-run', env.ZYLOS_RUN_ID, '--expected-runtime', 'claude',
    '--expected-session', hookData.session_id,
  ], { stdio: 'pipe', timeout: 5000 });
  return { skipped: false };
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

  await approvePermission(hookData);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(`[hook-auth-prompt] ${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
});
