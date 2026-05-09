/**
 * CodexAdapter — RuntimeAdapter implementation for OpenAI Codex CLI.
 *
 * Encapsulates all Codex-specific logic:
 *   - tmux session management (session: 'codex-main')
 *   - Auth detection via `codex login --status`
 *   - Instruction file generation (AGENTS.md)
 *   - Launch with --dangerously-bypass-approvals-and-sandbox flag
 *
 * Codex reads AGENTS.md from the working directory as its instruction file.
 * Interactive prompts are suppressed via project-level .codex/config.toml (headless
 * settings) and global ~/.codex/config.toml (trust declarations), both written
 * during `zylos init` by writeCodexConfig().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { RuntimeAdapter } from './base.js';
import { buildInstructionFile } from './instruction-builder.js';
import { CodexContextMonitor } from './codex-context-monitor.js';
import { createCodexProbe } from '../heartbeat/codex-probe.js';
import { ZYLOS_DIR, SKILLS_DIR, getZylosConfig } from '../config.js';
import {
  tmuxHasSession,
  tmuxGetPanePid,
  tmuxKillSession,
  tmuxPasteBuffer,
  tmuxDeleteBuffer,
  tmuxCapturePaneText,
  tmuxSendKeys,
  tmuxNewSession,
  getProcessName,
  hasChildProcess,
} from './tmux-helpers.js';
import { buildCleanEnv, buildCompatEnv, writeLaunchSpec } from './tmux-env.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SESSION = 'codex-main';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// When CODEX_BYPASS_PERMISSIONS=false, skip --dangerously-bypass-approvals-and-sandbox.
// Defaults to enabled for unattended server operation.
const DEFAULT_BYPASS = process.env.CODEX_BYPASS_PERMISSIONS !== 'false';

function getCodexApiBaseUrl() {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const config = fs.readFileSync(configPath, 'utf8');
    const match = config.match(/^\s*openai_base_url\s*=\s*"([^"]+)"\s*$/m);
    if (match?.[1]) {
      return match[1].replace(/\/+$/, '');
    }
  } catch { /* ignore missing config */ }

  if (process.env.OPENAI_BASE_URL) {
    return process.env.OPENAI_BASE_URL.replace(/\/+$/, '');
  }

  return 'https://api.openai.com/v1';
}

export function isOnboardingPendingState(stateContent = '') {
  return /^-\s+Status:\s+pending\b/m.test(stateContent);
}

export function buildCodexBootstrapPrompt(zylosDir = ZYLOS_DIR) {
  const memInjectScript = path.join(zylosDir, '.claude', 'skills', 'zylos-memory', 'scripts', 'session-start-inject.js');
  const sessionInitScript = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-session-init.js');
  const startupPromptScript = path.join(zylosDir, '.claude', 'skills', 'activity-monitor', 'scripts', 'session-start-prompt.js');
  const statePath = path.join(zylosDir, 'memory', 'state.md');

  let onboardingPending = false;
  try {
    const stateContent = fs.readFileSync(statePath, 'utf8');
    onboardingPending = isOnboardingPendingState(stateContent);
  } catch {
    onboardingPending = false;
  }

  const lines = [
    'Codex session bootstrap: run the following startup steps in order before doing any other work.',
    `1) node "${memInjectScript}"`,
    '   Read its stdout as startup memory context (identity/state/references).',
    `2) node "${sessionInitScript}"`,
    '   Read its stdout as C4 startup context (checkpoint + recent conversations).',
  ];

  if (onboardingPending) {
    lines.push(
      '3) Do not run the startup follow-up trigger yet because onboarding is pending.',
      '   Wait for the first real user message with a `reply via:` path before any proactive reply, onboarding notice, or ongoing-task continuation.',
      'Then stop and wait for that user message.'
    );
  } else {
    lines.push(
      `3) node "${startupPromptScript}"`,
      '   This enqueues the startup control message for active follow-up.',
      'Then continue according to the latest control message and ongoing conversation context.'
    );
  }

  return lines.join('\n');
}

// ── CodexAdapter ──────────────────────────────────────────────────────────────

export class CodexAdapter extends RuntimeAdapter {
  get displayName() { return 'Codex'; }
  get runtimeId() { return 'codex'; }
  get sessionName()  { return 'codex-main'; }

  // ── Instruction file ───────────────────────────────────────────────────────

  /**
   * Build AGENTS.md = ZYLOS.md + codex-addon.md.
   *
   * @param {object} [opts]
   * @param {string} [opts.memorySnapshot] - Memory content to append (e.g. on session rotation)
   * @returns {Promise<string>} Path to the generated AGENTS.md
   */
  async buildInstructionFile(opts = {}) {
    return buildInstructionFile('codex', opts);
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
   *   { ok: true }  — authorized, or uncertain outcome (network error, timeout, non-401 HTTP error)
   *   { ok: false } — explicit 401 from OpenAI API, or not logged in
   *
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  async checkAuth() {
    // Read auth.json to determine the auth mode.
    let authMode = null;
    let apiKey = '';
    try {
      const authJson = JSON.parse(fs.readFileSync(
        path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'
      ));
      authMode = authJson?.auth_mode || null;
      // Only extract the API key when the mode is explicitly "apikey".
      if (authMode === 'apikey') {
        apiKey = authJson?.OPENAI_API_KEY || authJson?.apiKey || '';
      }
    } catch { /* auth.json absent or malformed — fall through to codex login status */ }

    if (authMode === 'chatgpt' || (authMode !== 'apikey' && !apiKey)) {
      // OAuth/device auth, or no auth.json — defer to the CLI which reads auth.json natively.
      try {
        await execFileAsync(CODEX_BIN, ['login', 'status'], {
          stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
        });
        return { ok: true, reason: 'codex_login_status' };
      } catch { /* binary missing, not logged in, or other error */ }
      return { ok: false, reason: 'not_logged_in' };
    }

    // auth_mode = "apikey" — live HTTP probe to OpenAI API.
    // Guard against corrupted auth.json (mode set to "apikey" but key missing).
    if (!apiKey) return { ok: false, reason: 'apikey_mode_but_no_key' };
    try {
      const baseUrl = getCodexApiBaseUrl();
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 200) return { ok: true, reason: 'http_probe_200' };
      if (res.status === 401) return { ok: false, reason: 'http_probe_401' };
      // 429 (rate limit), 5xx, etc. — uncertain, don't block restart.
      return { ok: true, reason: `http_probe_uncertain_${res.status}` };
    } catch {
      // Network error or timeout — uncertain, don't block restart.
      return { ok: true, reason: 'http_probe_network_error_skip' };
    }
  }

  // ── Process / tmux ────────────────────────────────────────────────────────

  /**
   * @returns {Promise<boolean>}
   */
  async isRunning() {
    if (!tmuxHasSession(SESSION)) return false;

    const panePid = tmuxGetPanePid(SESSION);
    if (!panePid) return false;

    const name = getProcessName(panePid);
    if (name === 'codex' || name === 'node') return true;

    return hasChildProcess(panePid, 'codex');
  }

  /**
   * Kill the tmux session for this runtime.
   * Synchronous — HeartbeatEngine calls this without await.
   */
  stop() {
    tmuxKillSession(SESSION);
  }

  /**
   * Inject a message into the running Codex session via tmux.
   * Uses the buffer paste technique to handle special characters safely.
   * Validated to work with `codex --dangerously-bypass-approvals-and-sandbox`.
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async sendMessage(text) {
    const msgId = `${Date.now()}-${process.pid}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-'));
    const tmpFile = path.join(tmpDir, 'msg.txt');
    const bufferName = `zylos-${msgId}`;

    try {
      fs.writeFileSync(tmpFile, text);
      tmuxPasteBuffer(SESSION, tmpFile, bufferName);
    } finally {
      try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch { }
      tmuxDeleteBuffer(bufferName);
    }
  }

  clearStaleState() {
    try {
      this.getHeartbeatDeps()?.clearHeartbeatPending?.();
    } catch { }
    try { fs.unlinkSync('/tmp/context-alert-cooldown'); } catch { }
    try { fs.unlinkSync('/tmp/context-compact-scheduled'); } catch { }
  }

  enqueueStartupPrompt() {
    // Codex receives the bootstrap prompt as the initial launch argument.
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  /**
   * Build the instruction file and start Codex in the tmux session.
   *
   * New session: builds env via launcher pipeline (clean or compat mode).
   * Existing session: sends command via sendMessage with bootstrap prompt.
   * Auth is handled by Codex internally (reads ~/.codex/auth.json via HOME).
   *
   * @param {object} [opts]
   * @param {boolean} [opts.bypassPermissions] - Override default bypass setting
   * @returns {Promise<void>}
   */
  async launch(opts = {}) {
    const bypassPermissions = opts.bypassPermissions ?? DEFAULT_BYPASS;

    // 1. Build AGENTS.md before launching (pass memorySnapshot for session rotation)
    await this.buildInstructionFile({ memorySnapshot: opts.memorySnapshot });

    // 1.5. Ensure .agents/skills → .claude/skills symlink for Codex skill discovery.
    const agentsDir = path.join(ZYLOS_DIR, '.agents');
    const agentsSkillsPath = path.join(agentsDir, 'skills');
    let agentsSkillsExists = false;
    try { fs.lstatSync(agentsSkillsPath); agentsSkillsExists = true; } catch { /* not present */ }
    if (!agentsSkillsExists) {
      try {
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.symlinkSync(SKILLS_DIR, agentsSkillsPath);
      } catch { /* non-fatal */ }
    }

    // 2. Build the bootstrap prompt
    let bootstrapPrompt = null;
    try {
      bootstrapPrompt = buildCodexBootstrapPrompt(ZYLOS_DIR);
    } catch { /* prompt build failed — launch without initial prompt */ }

    // 3. Build the codex command
    const bypassFlag = bypassPermissions ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    const codexCmd = `${CODEX_BIN}${bypassFlag}`;

    const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');
    const exitLogFile = path.join(monitorDir, 'codex-exit.log');
    const exitLogSnippet = `_ec=$?; echo "[$(date -Iseconds)] exit_code=$_ec" >> "${exitLogFile}"`;

    if (tmuxHasSession(SESSION)) {
      // Existing session — sendMessage with bootstrap prompt, no env rebuild
      let cmd;
      if (bootstrapPrompt) {
        const tmpPrompt = path.join(os.tmpdir(), `.zylos-prompt-${process.pid}-${Date.now()}`);
        fs.writeFileSync(tmpPrompt, bootstrapPrompt, { mode: 0o600 });
        cmd = `cd "${ZYLOS_DIR}"; _p=$(cat "${tmpPrompt}"); rm -f "${tmpPrompt}"; ${codexCmd} "$_p"; ${exitLogSnippet}`;
      } else {
        cmd = `cd "${ZYLOS_DIR}"; ${codexCmd}; ${exitLogSnippet}`;
      }
      await this.sendMessage(cmd);
    } else {
      // New session — launcher pipeline
      const dotenvVars = _readDotenvVars();
      const useCleanEnv = dotenvVars.ZYLOS_CLEAN_ENV === 'true';

      const { env } = useCleanEnv
        ? buildCleanEnv({ processEnv: process.env, dotenvVars })
        : buildCompatEnv({ processEnv: process.env, dotenvVars });

      // Build launch spec — Codex reads auth from ~/.codex/auth.json via HOME
      const args = [];
      if (bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
      if (bootstrapPrompt) args.push(bootstrapPrompt);

      const launcherPath = path.join(path.dirname(import.meta.url.replace('file://', '')), 'tmux-launcher.js');
      const specPath = writeLaunchSpec({
        command: CODEX_BIN,
        args,
        env,
        cwd: ZYLOS_DIR,
        exitLogFile,
      });

      // tmux args — minimal env for launcher to start
      const tmuxArgs = [
        'new-session', '-d', '-s', SESSION,
        '-e', `PATH=${env.PATH}`,
        '-e', `HOME=${env.HOME}`,
        '-e', `TERM=${env.TERM || 'xterm-256color'}`,
        '--', `node "${launcherPath}" "${specPath}"`,
      ];

      try {
        tmuxNewSession(tmuxArgs);
      } catch (e) {
        try { fs.unlinkSync(specPath); } catch { }
        throw new Error(`Failed to create tmux session: ${e.message}`);
      }
    }

    // 4. Schedule startup dialog check (8s after launch)
    setTimeout(() => {
      try {
        const pane = tmuxCapturePaneText(SESSION);
        if (!pane) return;
        const hasMenu = /›\s+\d+\./m.test(pane) || /press enter to continue/i.test(pane);
        const hasStatusBar = /\d+%\s+left\s+·/.test(pane);
        if (hasMenu && !hasStatusBar) {
          tmuxSendKeys(SESSION, '1', 'Enter');
        }
      } catch { /* non-fatal */ }
    }, 8000);
  }

  // ── Heartbeat / context (Phase 5) ─────────────────────────────────────────

  /**
   * Returns runtime-specific HeartbeatEngine deps for Codex CLI.
   * Dual-signal probe: rollout JSONL mtime + tmux pane line count.
   *
   * Includes: enqueueHeartbeat, getHeartbeatStatus, detectRateLimit,
   *           readHeartbeatPending, clearHeartbeatPending.
   *
   * @returns {object}
   */
  getHeartbeatDeps() {
    const pendingFile = path.join(ZYLOS_DIR, 'activity-monitor', 'codex-heartbeat-pending.json');
    return createCodexProbe({ pendingFile, tmuxSession: SESSION });
  }

  /**
   * Returns a CodexContextMonitor instance for this runtime.
   * Reads threshold from config.json `codex_new_session_threshold` (default 75%).
   * @returns {CodexContextMonitor}
   */
  getContextMonitor() {
    const config = getZylosConfig();
    const val = parseInt(config.codex_new_session_threshold, 10);
    const threshold = (!isNaN(val) && val > 0 && val <= 100) ? val / 100 : 0.75;
    return new CodexContextMonitor({ threshold });
  }
}


// ── Private helpers ────────────────────────────────────────────────────────

function _readDotenvVars() {
  const vars = {};
  try {
    const content = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      vars[key] = val;
    }
  } catch { /* .env absent */ }
  return vars;
}
