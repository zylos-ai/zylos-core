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

  // ── Instruction file ───────────────────────────────────────────────────────

  /**
   * Build AGENTS.md = ZYLOS.md + codex-addon.md.
   * @returns {Promise<string>} Path to the generated AGENTS.md
   */
  async buildInstructionFile() {
    return buildInstructionFile('codex');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Check if Codex CLI is authenticated.
   * `codex login --status` exits 0 when authenticated, non-zero otherwise.
   *
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  async checkAuth() {
    try {
      const result = spawnSync(CODEX_BIN, ['login', '--status'], {
        stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
      });
      if (result.status === 0) {
        return { ok: true, reason: 'codex login --status: authenticated' };
      }
      return { ok: false, reason: 'not logged in (run: codex login)' };
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

    const panePid = _getTmuxPanePid();
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
   * @returns {Promise<void>}
   */
  async stop() {
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

    // 1. Build AGENTS.md before launching
    await this.buildInstructionFile();

    // 2. Build the codex command
    const bypassFlag = bypassPermissions ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    const codexCmd = `${CODEX_BIN}${bypassFlag}`;

    const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');
    const exitLogFile = path.join(monitorDir, 'codex-exit.log');
    const exitLogSnippet = `_ec=$?; echo "[$(date -Iseconds)] exit_code=$_ec" >> ${exitLogFile}`;

    if (_tmuxHasSession()) {
      // Existing session — send command via tmux
      const cmd = `cd ${ZYLOS_DIR}; ${codexCmd}; ${exitLogSnippet}`;
      await this.sendMessage(cmd);
    } else {
      // New tmux session
      const tmuxArgs = ['new-session', '-d', '-s', SESSION, '-e', `PATH=${process.env.PATH}`];
      if (process.getuid?.() === 0) tmuxArgs.push('-e', 'IS_SANDBOX=1');

      const shellCmd = `cd ${ZYLOS_DIR} && ${codexCmd}; ${exitLogSnippet}`;
      tmuxArgs.push('--', shellCmd);

      try {
        execFileSync('tmux', tmuxArgs);
      } catch (e) {
        throw new Error(`Failed to create tmux session: ${e.message}`);
      }
    }
  }

  // ── Heartbeat / context (Phase 5) ─────────────────────────────────────────

  /**
   * HeartbeatEngine deps — implemented in Phase 5.
   * @returns {null}
   */
  getHeartbeatDeps() {
    return null;
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
