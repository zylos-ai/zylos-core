/**
 * CodexAdapter — RuntimeAdapter implementation for OpenAI Codex CLI.
 *
 * Encapsulates all Codex-specific logic:
 *   - Explicit session lifecycle through SessionAdapter
 *   - Auth detection via `codex login --status`
 *   - Instruction file generation (AGENTS.md)
 *   - Isolated launches with --no-daemon when supported by the installed CLI
 *   - Optional --dangerously-bypass-approvals-and-sandbox flag
 *
 * Codex reads AGENTS.md from the working directory as its instruction file.
 * Interactive prompts are suppressed via project-level .codex/config.toml (headless
 * settings) and global ~/.codex/config.toml (trust declarations), both written
 * during `zylos init` by writeCodexConfig().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { SessionAdapter } from './session-adapter.js';
import { buildInstructionFile } from './instruction-builder.js';
import { classifyCodexLoginStatus } from '../auth-parsers.js';
import { ZYLOS_DIR } from '../config.js';
import { ensureLaunchHooksTrusted } from './codex-launch-trust.js';
import { launchEnvironment, runtimeExecutable } from './session-command.js';

// ── Constants ────────────────────────────────────────────────────────────────

function getCodexApiBaseUrl(env) {
  try {
    const configPath = path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'config.toml');
    const config = fs.readFileSync(configPath, 'utf8');
    const match = config.match(/^\s*openai_base_url\s*=\s*"([^"]+)"\s*$/m);
    if (match?.[1]) {
      return match[1].replace(/\/+$/, '');
    }
  } catch { /* ignore missing config */ }

  if (env.OPENAI_BASE_URL) {
    return env.OPENAI_BASE_URL.replace(/\/+$/, '');
  }

  return 'https://api.openai.com/v1';
}

// ── CodexAdapter ──────────────────────────────────────────────────────────────

export class CodexAdapter extends SessionAdapter {
  get displayName() { return 'Codex'; }
  get runtimeId() { return 'codex'; }

  async launch(options) {
    const env = this.options.env || process.env;
    const root = await fs.promises.realpath(this.options.root || ZYLOS_DIR);
    const codexBin = (this.options.runtimeExecutable || runtimeExecutable)('codex', env);
    // Trust must succeed before SessionAdapter can create a tmux session.
    await ensureLaunchHooksTrusted({ zylosDir: root, projectDir: root,
      codexBin, env: launchEnvironment(root, env) });
    return super.launch(options);
  }

  // ── Instruction file ───────────────────────────────────────────────────────

  /**
   * Build AGENTS.md from the activated split instruction layers.
   * @returns {Promise<string>} Path to the generated AGENTS.md
   */
  async buildInstructionFile() {
    return buildInstructionFile('codex');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Live auth check. Branches on auth_mode in ~/.codex/auth.json:
   *
   *   auth_mode = "apikey"  → live HTTP probe to OpenAI /v1/models with the stored key.
   *                           Detects revoked/expired keys that local file checks cannot catch.
   *   auth_mode = "chatgpt" → skip HTTP probe entirely; use `codex login status` (OAuth/device auth).
   *   auth.json absent      → fall through to `codex login status`.
   *
   * We do NOT read ~/zylos/.env — Codex CLI deliberately ignores OPENAI_API_KEY env vars,
   * so a stale key in .env must never override a later OAuth login in auth.json.
   *
   * Return values:
   *   { status: 'success' }   — authenticated
   *   { status: 'failure' }   — explicit auth failure
   *   { status: 'uncertain' } — probe could not confirm either way
   *
   * @returns {Promise<{status: 'success'|'failure'|'uncertain', reason: string}>}
   */
  async checkAuth() {
    const env = this.options.env || process.env;
    // Read auth.json to determine the auth mode.
    let authMode = null;
    let apiKey = '';
    try {
      const authJson = JSON.parse(fs.readFileSync(
        path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'auth.json'), 'utf8'
      ));
      authMode = authJson?.auth_mode || null;
      // Only extract the API key when the mode is explicitly "apikey".
      if (authMode === 'apikey') {
        apiKey = authJson?.OPENAI_API_KEY || authJson?.apiKey || '';
      }
    } catch { /* auth.json absent or malformed — fall through to codex login status */ }

    if (authMode === 'chatgpt' || (authMode !== 'apikey' && !apiKey)) {
      // OAuth/device auth, or no auth.json — defer to the CLI which reads auth.json natively.
      // NOTE: `codex login status` exits 0 in BOTH states ("Logged in using ..." and
      // "Not logged in"), so a non-throwing call does NOT mean authenticated — parse
      // the output text. Treating exit 0 as "ok" here would false-pass a logged-out
      // OAuth session straight through the runtime-switch / health-probe auth gate.
      // The status line is written to STDERR (stdout is empty), so combine streams.
      try {
        const { stdout, stderr } = await (this.options.execFile || execFileAsync)(env.CODEX_BIN || 'codex', ['login', 'status'], {
          env, stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
        });
        const status = classifyCodexLoginStatus((stdout || '') + (stderr || ''));
        if (status === 'success') return { status: 'success', reason: 'codex_login_status' };
        if (status === 'failure') return { status: 'failure', reason: 'not_logged_in' };
        return { status: 'uncertain', reason: 'codex_login_status_uncertain' };
      } catch { /* binary missing, killed, or other error */ }
      return { status: 'uncertain', reason: 'codex_login_status_unavailable' };
    }

    // auth_mode = "apikey" — live HTTP probe to OpenAI API.
    // Guard against corrupted auth.json (mode set to "apikey" but key missing).
    if (!apiKey) return { status: 'failure', reason: 'apikey_mode_but_no_key' };
    try {
      const baseUrl = getCodexApiBaseUrl(env);
      const res = await (this.options.fetch || fetch)(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 200) return { status: 'success', reason: 'http_probe_200' };
      if (res.status === 401) return { status: 'failure', reason: 'http_probe_401' };
      return { status: 'uncertain', reason: `http_probe_uncertain_${res.status}` };
    } catch {
      return { status: 'uncertain', reason: 'http_probe_network_error' };
    }
  }

}

