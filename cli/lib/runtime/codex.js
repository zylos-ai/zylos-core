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
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { RuntimeAdapter } from './base.js';
import { buildInstructionFile } from './instruction-builder.js';
import { CodexContextMonitor } from './codex-context-monitor.js';
import { createCodexProbe } from '../heartbeat/codex-probe.js';
import { ZYLOS_DIR } from '../config.js';

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
   * Check if Codex CLI is authenticated.
   *
   * Auth is accepted via two paths (checked in order):
   *   1. Environment variables: OPENAI_API_KEY or CODEX_API_KEY present — Codex
   *      reads these directly, so no persistent login is needed. This covers
   *      Docker / server deployments where credentials are injected via env.
   *   2. `codex login --status` exits 0 — interactive / OAuth login path.
   *
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  async checkAuth() {
    // Path 1: env-var credentials (Docker / server deployments).
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) {
      return { ok: true, reason: 'env-var auth (OPENAI_API_KEY / CODEX_API_KEY)' };
    }

    // Path 2: API key in ~/zylos/.env (covers `zylos init` / `zylos status` where
    // the key is stored in .env but not exported to the calling process's env).
    try {
      const envContent = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
      if (/^OPENAI_API_KEY=\S+/m.test(envContent) || /^CODEX_API_KEY=\S+/m.test(envContent)) {
        return { ok: true, reason: 'OPENAI_API_KEY / CODEX_API_KEY in .env' };
      }
    } catch { /* .env absent — not an auth path */ }

    // Path 3: persistent login via `codex login status` (subcommand, not flag).
    try {
      const result = spawnSync(CODEX_BIN, ['login', 'status'], {
        stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
      });
      // spawnSync sets result.error (status=null) when the binary is missing —
      // it does NOT throw, so we must check explicitly.
      if (result.error) throw result.error;
      if (result.status === 0) {
        return { ok: true, reason: 'codex login --status: authenticated' };
      }
      return { ok: false, reason: 'not logged in (run: codex login or set OPENAI_API_KEY)' };
    } catch (e) {
      return { ok: false, reason: e.message };
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

    // 2. Gather recent C4 conversation context to inject as the initial user prompt.
    //    This mirrors Claude's c4-session-init.js SessionStart hook — Codex has no
    //    hook mechanism, so we inject context at launch time instead.
    let tmpPrompt = null;
    try {
      const sessionInitScript = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-session-init.js');
      const result = spawnSync('node', [sessionInitScript], { encoding: 'utf8', timeout: 10_000 });
      const context = result.stdout?.trim();
      if (result.status === 0 && context) {
        tmpPrompt = path.join(os.tmpdir(), `.zylos-prompt-${process.pid}-${Date.now()}`);
        fs.writeFileSync(tmpPrompt, context, { mode: 0o600 });
      }
    } catch { /* c4 context unavailable — launch without initial prompt */ }

    // 3. Build the codex command
    const bypassFlag = bypassPermissions ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    const codexCmd = `${CODEX_BIN}${bypassFlag}`;

    const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');
    const exitLogFile = path.join(monitorDir, 'codex-exit.log');
    const exitLogSnippet = `_ec=$?; echo "[$(date -Iseconds)] exit_code=$_ec" >> "${exitLogFile}"`;

    if (_tmuxHasSession()) {
      // Existing session — send command via tmux
      const cmd = tmpPrompt
        ? `cd "${ZYLOS_DIR}"; _p=$(cat "${tmpPrompt}"); rm -f "${tmpPrompt}"; ${codexCmd} "$_p"; ${exitLogSnippet}`
        : `cd "${ZYLOS_DIR}"; ${codexCmd}; ${exitLogSnippet}`;
      await this.sendMessage(cmd);
    } else {
      // New tmux session — inject API keys from ~/zylos/.env so Codex can
      // authenticate in env-var deployments (Docker / server / PM2 restart).
      let tmpEnv = null;
      try {
        const envContent = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
        const openaiMatch = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
        const codexApiMatch = envContent.match(/^CODEX_API_KEY=(.+)$/m);
        const envParts = [];
        if (openaiMatch) envParts.push(`OPENAI_API_KEY=${openaiMatch[1]}`);
        if (codexApiMatch) envParts.push(`CODEX_API_KEY=${codexApiMatch[1]}`);
        if (envParts.length > 0) {
          tmpEnv = path.join(os.tmpdir(), `.zylos-env-${process.pid}-${Date.now()}`);
          fs.writeFileSync(tmpEnv, envParts.join('\n') + '\n', { mode: 0o600 });
        }
      } catch { /* .env absent or no keys — Codex will use native login */ }

      const tmuxArgs = ['new-session', '-d', '-s', SESSION, '-e', `PATH=${process.env.PATH}`];
      if (process.getuid?.() === 0) tmuxArgs.push('-e', 'IS_SANDBOX=1');

      const promptSnippet = tmpPrompt
        ? `_p=$(cat "${tmpPrompt}"); rm -f "${tmpPrompt}"; ${codexCmd} "$_p"`
        : codexCmd;
      const shellCmd = tmpEnv
        ? `set -a; . "${tmpEnv}"; set +a; rm -f "${tmpEnv}"; cd "${ZYLOS_DIR}" && ${promptSnippet}; ${exitLogSnippet}`
        : `cd "${ZYLOS_DIR}" && ${promptSnippet}; ${exitLogSnippet}`;
      tmuxArgs.push('--', shellCmd);

      try {
        execFileSync('tmux', tmuxArgs);
      } catch (e) {
        if (tmpEnv) try { fs.unlinkSync(tmpEnv); } catch { }
        if (tmpPrompt) try { fs.unlinkSync(tmpPrompt); } catch { }
        throw new Error(`Failed to create tmux session: ${e.message}`);
      }
    }
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
