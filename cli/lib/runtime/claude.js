/**
 * ClaudeAdapter — RuntimeAdapter implementation for Claude Code.
 *
 * Encapsulates all Claude Code-specific logic:
 *   - tmux session management
 *   - Auth: .env credentials (pre-approved) passed to the session; auth probe
 *   - Onboarding/trust pre-acceptance
 *   - Instruction file generation (CLAUDE.md)
 *
 * This adapter is the clean interface that callers should use.
 * activity-monitor.js still contains its own parallel implementation
 * (to be migrated in Phase 7).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { SessionAdapter } from './session-adapter.js';
import { buildInstructionFile } from './instruction-builder.js';
import { ZYLOS_DIR } from '../config.js';
import { probeEnvironment } from './session-command.js';
import { writePrivateFile } from '../private-file.js';


const ENV_VARS_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

// Credentials from .env are always passed to Claude, also when a subscription
// login exists (the subscription is used only when .env has none). Claude Code
// asks interactively, default No, before using an environment API key it has
// not seen, so these are pre-approved whenever the session carries them.
const PRE_APPROVED_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// Missing or malformed configuration starts empty; filesystem errors remain
// best-effort failures handled independently for each confirmation file.
function readConfirmationConfig(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function ensureOnboardingComplete(projectDir, env, preApprove = []) {
  const home = env.HOME || os.homedir();
  const claudeJsonPath = path.join(home, '.claude.json');
  try {
    const config = readConfirmationConfig(claudeJsonPath);
    let changed = false;
    const fill = (object, key, value) => {
      if (object[key] !== true) { object[key] = value; changed = true; }
    };
    if (config.hasCompletedOnboarding !== true) {
      fill(config, 'hasCompletedOnboarding', true);
      let version = '2.1.59';
      try {
        version = (await execFileAsync(env.CLAUDE_BIN || 'claude', ['--version'],
          { env, encoding: 'utf8', timeout: 5000 })).stdout.trim();
      } catch { /* Retain the baseline fallback when version discovery fails. */ }
      config.lastOnboardingVersion = version;
    }
    if (!config.effortCalloutDismissed) fill(config, 'effortCalloutDismissed', true);
    if (preApprove.length) {
      const responses = config.customApiKeyResponses;
      if (!responses || typeof responses !== 'object' || Array.isArray(responses)) config.customApiKeyResponses = { approved: [], rejected: [] };
      if (!Array.isArray(config.customApiKeyResponses.approved)) config.customApiKeyResponses.approved = [];
      for (const value of preApprove) {
        const suffix = value.slice(-20);
        if (!config.customApiKeyResponses.approved.includes(suffix)) { config.customApiKeyResponses.approved.push(suffix); changed = true; }
      }
    }
    if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) config.projects = {};
    let project = path.resolve(projectDir);
    try { project = await fs.promises.realpath(project); } catch { /* Keep confirmation repair best-effort if realpath is unavailable. */ }
    if (!config.projects[project] || typeof config.projects[project] !== 'object' || Array.isArray(config.projects[project])) config.projects[project] = {};
    if (config.projects[project].hasTrustDialogAccepted !== true) {
      fill(config.projects[project], 'hasTrustDialogAccepted', true);
      fill(config.projects[project], 'hasCompletedProjectOnboarding', true);
    }
    if (changed) writePrivateFile(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  } catch { /* First-confirmation repair must not prevent launch. */ }

  const settingsPath = path.join(home, '.claude', 'settings.json');
  try {
    const settings = readConfirmationConfig(settingsPath);
    if (settings.skipDangerousModePermissionPrompt !== true) {
      settings.skipDangerousModePermissionPrompt = true;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      writePrivateFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch { /* Other confirmation files are repaired independently. */ }
}

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

export class ClaudeAdapter extends SessionAdapter {
  get displayName() { return 'Claude Code'; }
  get runtimeId() { return 'claude'; }

  async launch(input) {
    const root = this.options.root || ZYLOS_DIR, env = this.options.env || process.env;
    let sessionEnv = {};
    try { sessionEnv = probeEnvironment(root, env, 'claude'); } catch { /* launch reports an unreadable .env */ }
    await ensureOnboardingComplete(root, env, PRE_APPROVED_KEYS.map(key => sessionEnv[key]).filter(Boolean));
    return super.launch(input);
  }

  // ── Instruction file ───────────────────────────────────────────────────────

  /**
   * Build CLAUDE.md from the activated split instruction layers.
   * @returns {Promise<string>} Path to the generated CLAUDE.md
   */
  async buildInstructionFile() {
    return buildInstructionFile('claude');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Live auth check via `claude -p ping --max-turns 1` (30s timeout).
   * End-to-end validation through the same path Claude Code uses at runtime.
   * Works with all credential types (API keys, setup tokens, OAuth tokens).
   *
   * Return values:
   *   { status: 'success' }   — authenticated
   *   { status: 'failure' }   — explicit auth failure
   *   { status: 'uncertain' } — probe could not confirm either way
   *
   * @returns {Promise<{status: 'success'|'failure'|'uncertain', reason: string}>}
   */
  async checkAuth() {
    // Build subprocess env: inherit current env, but take the built-in runtime
    // variables (RUNTIME_BUILTIN_ENV_KEYS) exactly as a new session gets them.
    const injectedEnv = probeEnvironment(this.options.root || ZYLOS_DIR, this.options.env || process.env, 'claude');

    // Strip vars that would make Claude refuse to start ("already running" guard).
    for (const v of ENV_VARS_TO_STRIP) delete injectedEnv[v];

    // Live CLI probe — `claude -p ping --max-turns 1`.
    // End-to-end validation: works with all credential types (API keys, setup tokens,
    // OAuth tokens) without needing to know the correct HTTP header format.
    // Claude Code handles credential routing internally.
    // Use async execFile — spawnSync would block the event loop for up to 30s.
    try {
      const { stdout } = await (this.options.execFile || execFileAsync)(injectedEnv.CLAUDE_BIN || 'claude', ['-p', 'ping', '--max-turns', '1'], {
        env: injectedEnv,
        timeout: 30_000,
        encoding: 'utf8',
      });
      // Safety net: some Claude versions exit 0 with "Not logged in" on stdout.
      if (stdout.includes('Not logged in')) {
        return { status: 'failure', reason: 'cli_probe_not_logged_in' };
      }
      return { status: 'success', reason: 'cli_probe' };
    } catch (err) {
      const output = (err.stdout ?? '') + (err.stderr ?? '');
      if (output.includes('authentication_error')) {
        return { status: 'failure', reason: 'cli_probe_authentication_error' };
      }
      const isTransient =
        output.includes('rate_limit_error') ||
        output.includes('api_error') ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        err.killed;
      if (isTransient) {
        return { status: 'uncertain', reason: 'cli_probe_uncertain' };
      }
      if (typeof err.code === 'number' && output.includes('Not logged in')) {
        return { status: 'failure', reason: 'cli_probe_not_logged_in' };
      }
      return { status: 'uncertain', reason: 'cli_probe_unexpected_error' };
    }
  }

}

