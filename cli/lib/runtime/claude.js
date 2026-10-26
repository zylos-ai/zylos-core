/**
 * ClaudeAdapter — RuntimeAdapter implementation for Claude Code.
 *
 * Encapsulates all Claude Code-specific logic:
 *   - tmux session management
 *   - Auth detection (credentials.json, claude auth status, .env tokens)
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


const ENV_VARS_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/**
 * Parse a value from a .env file, tolerating common formatting variations:
 *   - Spaces/tabs around key and `=`  (e.g. `KEY = value`)
 *   - Single/double quotes around value (e.g. `KEY="value"`)
 *   - Trailing whitespace
 *
 * @param {string} content - Full .env file content
 * @param {string} key     - Variable name to extract
 * @returns {string}       - Trimmed, unquoted value, or empty string if not found
 */
function _parseEnvValue(content, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const m = content.match(re);
  if (!m) return '';
  return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

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

async function ensureOnboardingComplete(projectDir, env) {
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
    if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) config.projects = {};
    let project = path.resolve(projectDir);
    try { project = await fs.promises.realpath(project); } catch { /* Keep confirmation repair best-effort if realpath is unavailable. */ }
    if (!config.projects[project] || typeof config.projects[project] !== 'object' || Array.isArray(config.projects[project])) config.projects[project] = {};
    if (config.projects[project].hasTrustDialogAccepted !== true) {
      fill(config.projects[project], 'hasTrustDialogAccepted', true);
      fill(config.projects[project], 'hasCompletedProjectOnboarding', true);
    }
    if (changed) fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  } catch { /* First-confirmation repair must not prevent launch. */ }

  const settingsPath = path.join(home, '.claude', 'settings.json');
  try {
    const settings = readConfirmationConfig(settingsPath);
    if (settings.skipDangerousModePermissionPrompt !== true) {
      settings.skipDangerousModePermissionPrompt = true;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch { /* Other confirmation files are repaired independently. */ }
}

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

export class ClaudeAdapter extends SessionAdapter {
  get displayName() { return 'Claude Code'; }
  get runtimeId() { return 'claude'; }

  async launch(input) {
    await ensureOnboardingComplete(this.options.root || ZYLOS_DIR, this.options.env || process.env);
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
    // Build subprocess env: inherit current env, inject .env API keys (same as launch()).
    const injectedEnv = { ...(this.options.env || process.env) };
    let envApiKey = '';
    let envOauthToken = '';
    let envBaseUrl = '';
    try {
      const envContent = fs.readFileSync(path.join(this.options.root || ZYLOS_DIR, '.env'), 'utf8');
      envApiKey = _parseEnvValue(envContent, 'ANTHROPIC_API_KEY');
      envOauthToken = _parseEnvValue(envContent, 'CLAUDE_CODE_OAUTH_TOKEN');
      envBaseUrl = _parseEnvValue(envContent, 'ANTHROPIC_BASE_URL');
      if (envApiKey) injectedEnv.ANTHROPIC_API_KEY = envApiKey;
      if (envOauthToken) injectedEnv.CLAUDE_CODE_OAUTH_TOKEN = envOauthToken;
      if (envBaseUrl) injectedEnv.ANTHROPIC_BASE_URL = envBaseUrl;
    } catch { /* .env absent — no keys to inject */ }

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
      return { status: 'uncertain', reason: 'cli_probe_unexpected_error' };
    }
  }

}

