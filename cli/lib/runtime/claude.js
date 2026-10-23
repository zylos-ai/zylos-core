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

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

export class ClaudeAdapter extends SessionAdapter {
  get displayName() { return 'Claude Code'; }
  get runtimeId() { return 'claude'; }

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

