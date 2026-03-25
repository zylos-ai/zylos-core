/**
 * zylos runtime — switch agent runtime without re-running full init.
 *
 * Usage:
 *   zylos runtime <name>                        Switch to the specified runtime (claude|codex)
 *   zylos runtime status                        Show the currently configured runtime
 *   zylos runtime <name> --save-apikey <key>    Save API key and switch (all runtimes)
 *   zylos runtime claude --save-setup-token <t> Save Claude setup token and switch
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getZylosConfig, updateZylosConfig, ZYLOS_DIR } from '../lib/config.js';
import { getAdapter, SUPPORTED_RUNTIMES } from '../lib/runtime/index.js';
import { buildInstructionFile } from '../lib/runtime/instruction-builder.js';
import { commandExists } from '../lib/shell-utils.js';
import {
  installClaude,
  installCodex,
  saveApiKey,
  saveApiKeyToEnv,
  saveSetupToken,
  saveSetupTokenToEnv,
  saveCodexApiKey,
  writeCodexConfig,
} from '../lib/runtime-setup.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;

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

  // zylos runtime <name> [flags]
  if (SUPPORTED_RUNTIMES.includes(sub)) {
    return switchRuntime(sub, args.slice(1));
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

// ── Credential save helpers ───────────────────────────────────────────────

/**
 * Save credentials for the target runtime and write to .env.
 * Returns true on success, false on failure.
 *
 * @param {string} target - 'claude' | 'codex'
 * @param {{ apiKey?: string, setupToken?: string }} creds
 * @returns {boolean}
 */
function applyCredentials(target, creds) {
  if (target === 'claude') {
    if (creds.setupToken) {
      if (!saveSetupToken(creds.setupToken)) return false;
      saveSetupTokenToEnv(creds.setupToken);
      return true;
    }
    if (creds.apiKey) {
      if (!saveApiKey(creds.apiKey)) return false;
      saveApiKeyToEnv(creds.apiKey);
      return true;
    }
  } else if (target === 'codex') {
    if (creds.apiKey) {
      return saveCodexApiKey(creds.apiKey);
    }
  }
  return false;
}

// ── Switch ────────────────────────────────────────────────────────────────

async function switchRuntime(target, flags) {
  const cfg = getZylosConfig();
  const current = cfg.runtime ?? 'claude';
  const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');

  if (current === target) {
    console.log(`Already on ${bold(target)} runtime.`);
    return;
  }

  // Parse credential flags
  const apiKeyIdx = flags.indexOf('--save-apikey');
  const setupTokenIdx = flags.indexOf('--save-setup-token');
  const apiKey = apiKeyIdx >= 0 ? flags[apiKeyIdx + 1] : null;
  const setupToken = setupTokenIdx >= 0 ? flags[setupTokenIdx + 1] : null;

  // Validate that flag values were actually provided (not undefined / another flag).
  if (apiKeyIdx >= 0 && (!apiKey || apiKey.startsWith('--'))) {
    console.error(red(`\nMissing value for --save-apikey.`));
    console.error(dim('  Example: zylos runtime codex --save-apikey sk-proj-xxx'));
    process.exit(1);
  }
  if (setupTokenIdx >= 0 && (!setupToken || setupToken.startsWith('--'))) {
    console.error(red(`\nMissing value for --save-setup-token.`));
    console.error(dim('  Example: zylos runtime claude --save-setup-token sk-ant-oat-xxx'));
    process.exit(1);
  }

  // Step 1: Ensure target runtime CLI is installed.
  if (!commandExists(target)) {
    console.log(`${bold(target)} CLI not found — installing...`);
    const installed = target === 'codex' ? installCodex() : installClaude();
    if (!installed || !commandExists(target)) {
      console.error(red(`\nFailed to install ${bold(target)} CLI.`));
      if (target === 'codex') {
        console.error(`  ${dim('Install manually: npm install -g @openai/codex')}`);
      } else {
        console.error(`  ${dim('Install manually: curl -fsSL https://claude.ai/install.sh | bash')}`);
      }
      process.exit(1);
    }
    console.log(`  ${green('✓')} installed`);
  }

  // Step 2: Apply credentials if provided via flags.
  if (apiKey || setupToken) {
    console.log(`Saving credentials for ${bold(target)}...`);
    if (!applyCredentials(target, { apiKey, setupToken })) {
      console.error(red(`\nFailed to save credentials.`));
      process.exit(1);
    }
    console.log(`  ${green('✓')} credentials saved`);
  }

  // Step 2b: Write Codex headless config (trust dir, suppress all interactive prompts).
  // Done before auth check so config is present when checkAuth spawns `codex login status`.
  if (target === 'codex') {
    writeCodexConfig(ZYLOS_DIR);
  }

  // Step 3: Check auth for target runtime.
  // An unauthenticated switch leaves the system unreachable via IM.
  console.log(`Checking ${bold(target)} authentication...`);
  const adapter = getAdapter(target, cfg);
  const auth = await adapter.checkAuth();
  if (!auth.ok) {
    console.error(red(`\n${bold(target)} is not authenticated.`));
    console.error(yellow('\nAuthenticate first, then retry. Options:\n'));
    if (target === 'codex') {
      console.error(`  ${cyan('zylos runtime codex --save-apikey <key>')}     ${dim('OpenAI API key')}`);
      console.error(`  ${cyan('codex login --device-auth')}                   ${dim('Device auth (headless, no browser)')}`);
      console.error(`  ${cyan('codex login')}                                 ${dim('Browser login (then retry)')}`);
    } else {
      console.error(`  ${cyan('zylos runtime claude --save-apikey <key>')}       ${dim('Anthropic API key (sk-ant-api...)')}`);
      console.error(`  ${cyan('zylos runtime claude --save-setup-token <token>')} ${dim('Setup token (sk-ant-oat...)')}`);
      console.error(`  ${cyan('claude auth login')}                               ${dim('Browser OAuth (then retry)')}`);
    }
    console.error(yellow('\nSwitch aborted — authenticate first to avoid losing IM access.'));
    process.exit(2);
  }
  console.log(`  ${green('✓')} authenticated`);

  // Step 4: Persist new runtime in config.
  updateZylosConfig({ runtime: target });

  // Step 5: Rebuild instruction file for the new runtime.
  console.log(`Rebuilding instruction file for ${bold(target)}...`);
  try {
    buildInstructionFile(target);
    console.log(`  ${green('✓')} done`);
  } catch (e) {
    console.error(`  ${yellow(`Warning: failed to rebuild instruction file — ${e.message}`)}`);
    console.error(`  ${dim('Check that ~/zylos/ZYLOS.md exists (run: zylos init --repair)')}`);
  }

  // Step 6: Clear stale health state from old runtime.
  try { fs.unlinkSync(path.join(monitorDir, 'agent-status.json')); } catch {}
  try { fs.unlinkSync(path.join(monitorDir, 'heartbeat-pending.json')); } catch {}
  try { fs.unlinkSync(path.join(monitorDir, 'codex-heartbeat-pending.json')); } catch {}

  // Step 7: Restart activity-monitor and c4-dispatcher.
  // activity-monitor starts the new runtime session on its next cycle and cleans up the old one.
  // c4-dispatcher caches TMUX_SESSION at startup from config.json — must restart so it picks up
  // the new session name; otherwise it keeps delivering messages to the old runtime's pane.
  // NOTE: Do NOT kill the old tmux session here. This command may run from inside the old
  // session (e.g. via "zylos attach"), and killing its own parent session would terminate
  // this process before the PM2 restart completes. The activity-monitor handles cleanup:
  // on startup it kills the other runtime's session (OTHER_SESSION in init()) after a
  // short delay, then starts the correct new session.
  console.log('\nRestarting services...');
  for (const svc of ['activity-monitor', 'c4-dispatcher']) {
    try {
      execSync(`pm2 restart ${svc}`, { stdio: 'pipe' });
      console.log(`  ${green('✓')} ${svc}`);
    } catch (e) {
      console.error(`  ${yellow(`Warning: pm2 restart ${svc} failed — ${e.message}`)}`);
    }
  }

  const targetLabel = target === 'codex' ? 'Codex (OpenAI)' : 'Claude Code (Anthropic)';
  console.log(`\n${green(`Switched to ${bold(targetLabel)}.`)}`);
  console.log(dim('The new runtime session will be ready in ~10 seconds.'));
}

// ── Help ──────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
zylos runtime — switch agent runtime

Usage:
  zylos runtime <name>                        Switch to the specified runtime
  zylos runtime status                        Show currently configured runtime
  zylos runtime <name> --save-apikey <key>    Save API key and switch
  zylos runtime claude --save-setup-token <t> Save Claude setup token and switch

Supported runtimes:
  claude    Claude Code (Anthropic) — default
  codex     Codex CLI (OpenAI)

Authentication options (if not already authenticated):
  Claude:  --save-apikey <sk-ant-api...>   Anthropic API key
           --save-setup-token <sk-ant-oat...>  Setup token
           claude auth login               Browser OAuth (then retry)
  Codex:   --save-apikey <sk-...>          OpenAI API key
           codex login --device-auth       Device auth (headless)
           codex login                     Browser login (then retry)

Exit codes:
  0  Success
  1  Fatal error (install failed, credential save failed)
  2  Auth required — use --save-apikey / --save-setup-token or authenticate first

Examples:
  zylos runtime status
  zylos runtime codex
  zylos runtime claude --save-apikey sk-ant-api-xxx
  zylos runtime claude --save-setup-token sk-ant-oat-xxx
  zylos runtime codex --save-apikey sk-proj-xxx
`);
}
