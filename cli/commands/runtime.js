/**
 * zylos runtime — switch agent runtime without re-running full init.
 *
 * Usage:
 *   zylos runtime <name>     Switch to the specified runtime (claude|codex)
 *   zylos runtime status     Show the currently configured runtime
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getZylosConfig, updateZylosConfig, ZYLOS_DIR } from '../lib/config.js';
import { getAdapter, SUPPORTED_RUNTIMES } from '../lib/runtime/index.js';
import { buildInstructionFile } from '../lib/runtime/instruction-builder.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Entry point for `zylos runtime [subcommand|name]`.
 *
 * @param {string[]} args - CLI args after "runtime"
 */
export async function runtimeCommand(args) {
  const sub = args[0];

  if (!sub || sub === 'status') {
    return showStatus();
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    return showHelp();
  }

  // zylos runtime <name>
  if (SUPPORTED_RUNTIMES.includes(sub)) {
    return switchRuntime(sub);
  }

  console.error(`Unknown subcommand: ${sub}`);
  showHelp();
  process.exit(1);
}

// ── Status ────────────────────────────────────────────────────────────────

function showStatus() {
  const cfg = getZylosConfig();
  const current = cfg.runtime ?? 'claude';
  const label = current === 'codex' ? 'Codex (OpenAI)' : 'Claude Code (Anthropic)';
  console.log(`Current runtime: ${bold(label)}`);
}

// ── Switch ────────────────────────────────────────────────────────────────

async function switchRuntime(target) {
  const cfg = getZylosConfig();
  const current = cfg.runtime ?? 'claude';
  const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');

  if (current === target) {
    console.log(`Already on ${bold(target)} runtime.`);
    return;
  }

  // Step 1: Check auth for target runtime.
  // An unauthenticated switch leaves the system unreachable via IM.
  console.log(`Checking ${bold(target)} authentication...`);
  const adapter = getAdapter(target, cfg);
  const auth = await adapter.checkAuth();
  if (!auth.ok) {
    console.error(red(`\n${bold(target)} is not authenticated: ${auth.reason}`));
    if (target === 'codex') {
      console.error(`  ${dim('Run: codex login')}`);
    } else {
      console.error(`  ${dim('Run: claude (and complete authentication)')}`);
    }
    console.error(yellow('\nSwitch aborted — authenticate first to avoid losing IM access.'));
    process.exit(1);
  }
  console.log(`  ${green('✓')} authenticated`);

  // Step 2: Persist new runtime in config.
  updateZylosConfig({ runtime: target });

  // Step 3: Rebuild instruction file for the new runtime.
  console.log(`Rebuilding instruction file for ${bold(target)}...`);
  try {
    buildInstructionFile(target);
    console.log(`  ${green('✓')} done`);
  } catch (e) {
    console.error(`  ${yellow(`Warning: failed to rebuild instruction file — ${e.message}`)}`);
    console.error(`  ${dim('Check that ~/zylos/ZYLOS.md exists (run: zylos init --repair)')}`);
  }

  // Step 4: Clear stale health state from old runtime.
  try { fs.unlinkSync(path.join(monitorDir, 'agent-status.json')); } catch {}
  try { fs.unlinkSync(path.join(monitorDir, 'heartbeat-pending.json')); } catch {}
  try { fs.unlinkSync(path.join(monitorDir, 'codex-heartbeat-pending.json')); } catch {}

  // Step 5: Restart activity-monitor — it will start the new runtime on its next cycle.
  // NOTE: Do NOT kill the old tmux session here. This command may run from inside the old
  // session (e.g. via "zylos attach"), and killing its own parent session would terminate
  // this process before the PM2 restart completes. The activity-monitor handles cleanup:
  // on startup it kills the other runtime's session (OTHER_SESSION in init()) after a
  // short delay, then starts the correct new session.
  console.log('\nRestarting activity-monitor...');
  try {
    execSync('pm2 restart activity-monitor', { stdio: 'pipe' });
    console.log(`  ${green('✓')} done`);
  } catch (e) {
    console.error(`  ${yellow(`Warning: pm2 restart failed — ${e.message}`)}`);
    console.error(`  ${dim('Try: pm2 restart activity-monitor')}`);
  }

  const targetLabel = target === 'codex' ? 'Codex (OpenAI)' : 'Claude Code (Anthropic)';
  console.log(`\n${green(`Switched to ${bold(targetLabel)}.`)}`);
  console.log(dim('The old session will be replaced in ~10 seconds. Then run: zylos attach'));
}

// ── Help ──────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
zylos runtime — switch agent runtime

Usage:
  zylos runtime <name>     Switch to the specified runtime
  zylos runtime status     Show currently configured runtime

Supported runtimes:
  claude    Claude Code (Anthropic) — default
  codex     Codex CLI (OpenAI)

Examples:
  zylos runtime status
  zylos runtime codex
  zylos runtime claude

Note: switching to an unauthenticated runtime will abort.
Authenticate first (e.g. "codex login") then retry.
`);
}
