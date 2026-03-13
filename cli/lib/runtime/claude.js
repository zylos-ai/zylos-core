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
import { execSync, execFileSync } from 'node:child_process';
import { RuntimeAdapter } from './base.js';
import { buildInstructionFile } from './instruction-builder.js';
import { ClaudeContextMonitor } from './claude-context-monitor.js';
import { createClaudeProbe } from '../heartbeat/claude-probe.js';
import { ZYLOS_DIR } from '../config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SESSION = 'claude-main';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// When CLAUDE_BYPASS_PERMISSIONS=false, skip --dangerously-skip-permissions.
// Defaults to enabled for unattended server operation.
const DEFAULT_BYPASS = process.env.CLAUDE_BYPASS_PERMISSIONS !== 'false';

// Claude Code sets these env vars at runtime to mark "I'm running".
// Strip them before launching to prevent child-process inheritance causing
// Claude to refuse startup ("already running" detection).
const ENV_VARS_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];
const ENV_CLEAN_PREFIX = 'env ' + ENV_VARS_TO_STRIP.map(v => `-u ${v}`).join(' ');

const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

export class ClaudeAdapter extends RuntimeAdapter {
  get displayName() { return 'Claude Code'; }
  get sessionName()  { return 'claude-main'; }

  // ── Instruction file ───────────────────────────────────────────────────────

  /**
   * Build CLAUDE.md = ZYLOS.md + claude-addon.md.
   * @returns {Promise<string>} Path to the generated CLAUDE.md
   */
  async buildInstructionFile() {
    return buildInstructionFile('claude');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  async checkAuth() {
    // First check credentials.json (OAuth refresh token — auto-renewable)
    if (_hasCredentialsFile()) {
      return { ok: true, reason: 'credentials.json present' };
    }

    // Then try `claude auth status` (JSON output)
    try {
      const out = execFileSync(CLAUDE_BIN, ['auth', 'status'], {
        encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const status = JSON.parse(out);
      if (status?.loggedIn === true) {
        return { ok: true, reason: `authenticated via ${status.authMethod || 'unknown'}` };
      }
      return { ok: false, reason: 'not logged in' };
    } catch (e) {
      // claude binary missing or timed out
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
      if (name === 'claude') return true;
    } catch { }

    // Check children of pane process
    try {
      execSync(`pgrep -P ${panePid} -f "claude" > /dev/null 2>&1`);
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
   * Inject a message into the running Claude session via tmux.
   * Uses the buffer paste technique to handle special characters safely.
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
   * Build the instruction file and start Claude Code in the tmux session.
   *
   * Auth strategy:
   *   - Native auth (credentials.json or claude.ai login): do NOT inject .env tokens
   *   - API key auth (.env ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN): inject via temp env file
   *
   * @param {object} [opts]
   * @param {boolean} [opts.bypassPermissions] - Override default bypass setting
   * @returns {Promise<void>}
   */
  async launch(opts = {}) {
    const bypassPermissions = opts.bypassPermissions ?? DEFAULT_BYPASS;

    // 1. Build instruction file before launching
    await this.buildInstructionFile();

    // 2. Pre-accept onboarding/trust dialogs (all auth methods)
    _ensureOnboardingComplete(ZYLOS_DIR);

    // 3. Detect auth method to avoid "Auth conflict" errors
    const useCredentialsFile = _hasCredentialsFile();
    let hasNativeAuth = useCredentialsFile;
    let apiKeyValue = '';
    let oauthTokenValue = '';

    if (!hasNativeAuth) {
      // Check if user is logged in via `claude login`
      try {
        const out = execFileSync(CLAUDE_BIN, ['auth', 'status'], {
          encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const status = JSON.parse(out);
        if (status?.loggedIn === true && status?.authMethod === 'claude.ai') {
          hasNativeAuth = true;
        }
      } catch { }
    }

    if (!hasNativeAuth) {
      // Read API tokens from .env — only when no native login
      try {
        const envContent = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
        const apiMatch = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
        if (apiMatch) apiKeyValue = apiMatch[1].trim();
        const oauthMatch = envContent.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
        if (oauthMatch) oauthTokenValue = oauthMatch[1].trim();
      } catch { }

      // Pre-approve API keys to skip interactive confirmation prompts
      if (apiKeyValue) _approveApiKey(apiKeyValue);
      if (oauthTokenValue) _approveApiKey(oauthTokenValue);
    }

    // 4. Build the shell command
    const bypassFlag = bypassPermissions ? ' --dangerously-skip-permissions' : '';
    const envStripFlags = hasNativeAuth
      ? ' -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY'
      : '';
    const claudeCmd = `${ENV_CLEAN_PREFIX}${envStripFlags} ${CLAUDE_BIN}${bypassFlag}`;

    const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');
    const exitLogFile = path.join(monitorDir, 'claude-exit.log');
    const exitLogSnippet = `_ec=$?; echo "[$(date -Iseconds)] exit_code=$_ec" >> ${exitLogFile}`;

    if (_tmuxHasSession()) {
      // Existing session — send command via tmux
      const cmd = `cd ${ZYLOS_DIR}; ${claudeCmd}; ${exitLogSnippet}`;
      await this.sendMessage(cmd);
    } else {
      // New tmux session
      const tmuxArgs = ['new-session', '-d', '-s', SESSION, '-e', `PATH=${process.env.PATH}`];
      if (process.getuid?.() === 0) tmuxArgs.push('-e', 'IS_SANDBOX=1');

      let shellCmd;
      let tmpEnv = null;

      if (!hasNativeAuth && (apiKeyValue || oauthTokenValue)) {
        // Write secrets to a temp file, source it, then delete it
        // Avoids exposing secrets in ps/proc/cmdline
        const envParts = [];
        if (apiKeyValue) envParts.push(`ANTHROPIC_API_KEY='${apiKeyValue}'`);
        if (oauthTokenValue) envParts.push(`CLAUDE_CODE_OAUTH_TOKEN='${oauthTokenValue}'`);
        tmpEnv = path.join(os.tmpdir(), `.zylos-env-${process.pid}-${Date.now()}`);
        fs.writeFileSync(tmpEnv, envParts.join('\n') + '\n', { mode: 0o600 });
        shellCmd = `set -a; . "${tmpEnv}"; set +a; rm -f "${tmpEnv}"; cd ${ZYLOS_DIR} && ${claudeCmd}; ${exitLogSnippet}`;
      } else {
        shellCmd = `cd ${ZYLOS_DIR} && ${claudeCmd}; ${exitLogSnippet}`;
      }

      tmuxArgs.push('--', shellCmd);

      try {
        execFileSync('tmux', tmuxArgs);
      } catch (e) {
        if (tmpEnv) try { fs.unlinkSync(tmpEnv); } catch { }
        throw new Error(`Failed to create tmux session: ${e.message}`);
      }
    }
  }

  // ── Heartbeat / context (Phase 5) ─────────────────────────────────────────

  /**
   * Returns runtime-specific HeartbeatEngine deps for Claude Code.
   * Includes: enqueueHeartbeat, getHeartbeatStatus, detectRateLimit,
   *           readHeartbeatPending, clearHeartbeatPending.
   *
   * Phase 7 will merge these with the remaining deps (killTmuxSession, etc.)
   * when migrating activity-monitor.js to use RuntimeAdapter.
   *
   * @returns {object}
   */
  getHeartbeatDeps() {
    const pendingFile = path.join(ZYLOS_DIR, 'activity-monitor', 'heartbeat-pending.json');
    return createClaudeProbe({ pendingFile, tmuxSession: SESSION });
  }

  /**
   * Returns a ClaudeContextMonitor instance for this runtime.
   * @returns {ClaudeContextMonitor}
   */
  getContextMonitor() {
    return new ClaudeContextMonitor();
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

function _hasCredentialsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    return !!(data.claudeAiOauth && data.claudeAiOauth.refreshToken);
  } catch {
    return false;
  }
}

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

/**
 * Pre-accept onboarding, workspace trust, and settings dialogs so Claude
 * starts without interactive prompts in the tmux session.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 */
function _ensureOnboardingComplete(projectDir) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { }

    let changed = false;
    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      try {
        config.lastOnboardingVersion = execFileSync(
          CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 5000 }
        ).trim();
      } catch {
        config.lastOnboardingVersion = '2.1.59';
      }
      changed = true;
    }
    if (!config.effortCalloutDismissed) {
      config.effortCalloutDismissed = true;
      changed = true;
    }
    if (!config.projects) config.projects = {};
    const abs = path.resolve(projectDir);
    if (!config.projects[abs]) config.projects[abs] = {};
    if (!config.projects[abs].hasTrustDialogAccepted) {
      config.projects[abs].hasTrustDialogAccepted = true;
      config.projects[abs].hasCompletedProjectOnboarding = true;
      changed = true;
    }
    if (changed) fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  } catch { }

  // ~/.claude/settings.json — skip dangerous-mode permission prompt
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { }
    if (!settings.skipDangerousModePermissionPrompt) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      settings.skipDangerousModePermissionPrompt = true;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch { }
}

/**
 * Pre-approve an API key in ~/.claude.json so Claude skips the
 * interactive "Detected a custom API key" confirmation prompt.
 *
 * @param {string} apiKey
 */
function _approveApiKey(apiKey) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { }
    if (!config.customApiKeyResponses) config.customApiKeyResponses = { approved: [], rejected: [] };
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    const suffix = apiKey.slice(-20);
    if (!config.customApiKeyResponses.approved.includes(suffix)) {
      config.customApiKeyResponses.approved.push(suffix);
      fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
    }
  } catch { }
}
