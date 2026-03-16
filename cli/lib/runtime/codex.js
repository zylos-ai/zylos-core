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
 * Interactive prompts are suppressed via ~/.codex/config.toml (trust_level = "trusted"),
 * which is written during `zylos init` by writeCodexConfig().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { RuntimeAdapter } from './base.js';
import { buildInstructionFile } from './instruction-builder.js';
import { CodexContextMonitor } from './codex-context-monitor.js';
import { createCodexProbe } from '../heartbeat/codex-probe.js';
import { ZYLOS_DIR, SKILLS_DIR } from '../config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SESSION = 'codex-main';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// When CODEX_BYPASS_PERMISSIONS=false, skip --dangerously-bypass-approvals-and-sandbox.
// Defaults to enabled for unattended server operation.
const DEFAULT_BYPASS = process.env.CODEX_BYPASS_PERMISSIONS !== 'false';

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
      const res = await fetch('https://api.openai.com/v1/models', {
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
    if (!_tmuxHasSession()) return false;

    const panePid = parseInt(_getTmuxPanePid(), 10);
    if (!panePid) return false;

    // Check direct process name
    try {
      const name = execSync(`ps -p ${panePid} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (name === 'codex' || name === 'node') return true;
    } catch { }

    // Check children of pane process for codex
    try {
      execSync(`pgrep -P ${panePid} -f "codex" > /dev/null 2>&1`);
      return true;
    } catch { }

    return false;
  }

  /**
   * Kill the tmux session for this runtime.
   * Synchronous — HeartbeatEngine calls this without await.
   */
  stop() {
    try {
      execSync(`tmux kill-session -t "${SESSION}" 2>/dev/null`);
    } catch { /* session may not exist */ }
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
      execSync(`tmux load-buffer -b "${bufferName}" "${tmpFile}" 2>/dev/null`);
      execSync(`sleep 0.1`);
      execSync(`tmux paste-buffer -b "${bufferName}" -t "${SESSION}" 2>/dev/null`);
      execSync(`sleep 0.2`);
      execSync(`tmux send-keys -t "${SESSION}" Enter 2>/dev/null`);
    } finally {
      try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch { }
      try { execSync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`); } catch { }
    }
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  /**
   * Build the instruction file and start Codex in the tmux session.
   *
   * Auth is handled by Codex internally (reads from ~/.codex/ credentials).
   * Interactive prompts are suppressed via ~/.codex/config.toml.
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
    // Codex follows the Agent Skills spec and looks for skills in <workdir>/.agents/skills/.
    // We point it to the canonical skills directory via symlink — no files need to move.
    const agentsDir = path.join(ZYLOS_DIR, '.agents');
    const agentsSkillsPath = path.join(agentsDir, 'skills');
    // Use lstatSync (not existsSync) so that a dangling symlink is detected and skipped
    // rather than triggering a redundant symlinkSync that would throw EEXIST silently.
    let agentsSkillsExists = false;
    try { fs.lstatSync(agentsSkillsPath); agentsSkillsExists = true; } catch { /* not present */ }
    if (!agentsSkillsExists) {
      try {
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.symlinkSync(SKILLS_DIR, agentsSkillsPath);
      } catch { /* non-fatal: Codex starts without skill discovery if symlink fails */ }
    }

    // 2. Build the initial user prompt by mirroring Claude's three SessionStart hooks:
    //    a) session-start-inject.js  → identity.md + state.md + references.md
    //    b) c4-session-init.js       → C4 conversation history + checkpoint summary
    //    c) session-start-prompt     → "reply to waiting partners / continue ongoing work"
    //
    //    Codex has no hook mechanism, so we inject all context at launch time instead.
    //    Memory files come first so the agent knows its state before reading conversations.
    let tmpPrompt = null;
    try {
      const parts = [];

      // a) Memory: identity + state + references (mirrors session-start-inject.js)
      const memInjectScript = path.join(ZYLOS_DIR, '.claude', 'skills', 'zylos-memory', 'scripts', 'session-start-inject.js');
      try {
        const memResult = spawnSync('node', [memInjectScript], { encoding: 'utf8', timeout: 10_000 });
        const memContext = memResult.stdout?.trim();
        if (memResult.status === 0 && memContext) parts.push(memContext);
      } catch { /* memory files unavailable — continue without them */ }

      // b) C4 conversation history (mirrors c4-session-init.js)
      const sessionInitScript = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-session-init.js');
      try {
        const c4Result = spawnSync('node', [sessionInitScript], { encoding: 'utf8', timeout: 10_000 });
        const c4Context = c4Result.stdout?.trim();
        if (c4Result.status === 0 && c4Context) parts.push(c4Context);
      } catch { /* c4 context unavailable — continue without it */ }

      // c) Active trigger (mirrors session-start-prompt.js)
      //    For fresh installs (onboarding pending), wait for user's first message —
      //    do NOT run any "continue your work" tasks first, as that skips onboarding.
      let activeTrigger;
      try {
        const statePath = path.join(ZYLOS_DIR, 'memory', 'state.md');
        const stateContent = fs.readFileSync(statePath, 'utf8');
        const onboardingPending = /^-\s+Status:\s+pending\b/m.test(stateContent);
        activeTrigger = onboardingPending
          ? 'Wait for the user\'s first message via C4 — onboarding is pending and must be completed first before any other work.'
          : 'reply to your human partner if they are waiting your reply, and continue your work if you have ongoing task according to the previous conversations.';
      } catch {
        activeTrigger = 'reply to your human partner if they are waiting your reply, and continue your work if you have ongoing task according to the previous conversations.';
      }
      parts.push(activeTrigger);

      const combined = parts.join('\n\n');
      tmpPrompt = path.join(os.tmpdir(), `.zylos-prompt-${process.pid}-${Date.now()}`);
      fs.writeFileSync(tmpPrompt, combined, { mode: 0o600 });
    } catch { /* prompt build failed — launch without initial prompt */ }

    // 3. Build the codex command
    const bypassFlag = bypassPermissions ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    const codexCmd = `${CODEX_BIN}${bypassFlag}`;

    const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');
    const exitLogFile = path.join(monitorDir, 'codex-exit.log');
    const exitLogSnippet = `_ec=$?; echo "[$(date -Iseconds)] exit_code=$_ec" >> "${exitLogFile}"`;

    if (_tmuxHasSession()) {
      const cmd = tmpPrompt
        ? `cd "${ZYLOS_DIR}"; _p=$(cat "${tmpPrompt}"); rm -f "${tmpPrompt}"; ${codexCmd} "$_p"; ${exitLogSnippet}`
        : `cd "${ZYLOS_DIR}"; ${codexCmd}; ${exitLogSnippet}`;
      await this.sendMessage(cmd);
    } else {
      const tmuxArgs = ['new-session', '-d', '-s', SESSION, '-e', `PATH=${process.env.PATH}`];
      if (process.getuid?.() === 0) tmuxArgs.push('-e', 'IS_SANDBOX=1');

      const promptSnippet = tmpPrompt
        ? `_p=$(cat "${tmpPrompt}"); rm -f "${tmpPrompt}"; ${codexCmd} "$_p"`
        : codexCmd;
      const shellCmd = `cd "${ZYLOS_DIR}" && ${promptSnippet}; ${exitLogSnippet}`;
      tmuxArgs.push('--', shellCmd);

      try {
        execFileSync('tmux', tmuxArgs);
      } catch (e) {
        if (tmpPrompt) try { fs.unlinkSync(tmpPrompt); } catch { }
        throw new Error(`Failed to create tmux session: ${e.message}`);
      }
    }

    // 4. Schedule a startup dialog check.
    // config.toml suppresses known interactive prompts, but new Codex versions may
    // introduce new dialogs (e.g. "Introducing GPT-X.Y") before config.toml is updated.
    //
    // This check runs 8 s after launch. We distinguish startup dialogs from normal
    // operation by checking the status bar:
    //   - Codex normal mode:  pane contains "· XX% left ·" (token usage status bar)
    //   - Startup dialog:     pane has "› N." menu entries but no status bar yet
    //
    // Only auto-dismiss when BOTH conditions hold:
    //   1. pane has a numbered menu (›  1. pattern)
    //   2. pane does NOT have the normal status bar ("% left ·")
    // This prevents false positives if Codex is already mid-response and outputs
    // a list containing "›  1." in the conversation text.
    setTimeout(() => {
      try {
        const pane = execSync(`tmux capture-pane -p -t "${SESSION}" 2>/dev/null`, { encoding: 'utf8' });
        const hasMenu = /›\s+\d+\./m.test(pane) || /press enter to continue/i.test(pane);
        const hasStatusBar = /\d+%\s+left\s+·/.test(pane);  // e.g. "94% left · ~/zylos"
        if (hasMenu && !hasStatusBar) {
          execSync(`tmux send-keys -t "${SESSION}" "1" Enter 2>/dev/null`);
        }
      } catch { /* non-fatal — Codex may have exited or session not ready */ }
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
   * @returns {CodexContextMonitor}
   */
  getContextMonitor() {
    return new CodexContextMonitor();
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

function _tmuxHasSession() {
  try {
    execSync(`tmux has-session -t "${SESSION}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function _getTmuxPanePid() {
  try {
    return execSync(
      `tmux list-panes -t "${SESSION}" -F '#{pane_pid}' 2>/dev/null | head -1`,
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
}
