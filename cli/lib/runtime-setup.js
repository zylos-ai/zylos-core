/**
 * runtime-setup.js — shared runtime install + auth helpers.
 *
 * Used by both `zylos init` and `zylos runtime` to avoid duplicating
 * install/auth logic. All functions are pure utilities with no side-effects
 * beyond writing to well-known credential files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { ZYLOS_DIR } from './config.js';
import { commandExists } from './shell-utils.js';

// ── Install ────────────────────────────────────────────────────────────────

/**
 * Install an npm global package.
 * @param {string} pkg - Package name (e.g. "@openai/codex")
 * @returns {boolean}
 */
export function installGlobalPackage(pkg) {
  try {
    execFileSync('npm', ['install', '-g', pkg], { stdio: 'pipe', timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the Codex CLI globally via npm.
 * @returns {boolean}
 */
export function installCodex() {
  return installGlobalPackage('@openai/codex');
}

/**
 * Install Claude Code via the official installer script.
 * @returns {boolean}
 */
export function installClaude() {
  try {
    execSync('curl -fsSL https://claude.ai/install.sh | bash', {
      stdio: 'pipe',
      timeout: 300000, // 5 min — downloads ~213MB native binary
    });
    return commandExists('claude');
  } catch {
    return false;
  }
}

// ── Auth checks ────────────────────────────────────────────────────────────

/**
 * Check if Claude Code is authenticated.
 * @returns {boolean}
 */
export function isClaudeAuthenticated() {
  try {
    const result = spawnSync('claude', ['auth', 'status'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Codex CLI is authenticated.
 * Checks three paths in order:
 *   1. Process env vars (OPENAI_API_KEY / CODEX_API_KEY) — set in-process by saveCodexApiKey()
 *      during the current init run
 *   2. ~/.codex/auth.json — direct read for auth_mode=apikey (avoids relying on `codex login status`
 *      which may return non-zero for API-key-only auth on some Codex CLI versions)
 *   3. `codex login status` — authoritative CLI check for OAuth/device auth (chatgpt auth_mode)
 * Note: does NOT read ~/zylos/.env — Codex CLI deliberately ignores env vars, so an API key
 * in .env has no meaning for Codex. Keys are stored in ~/.codex/auth.json (see saveCodexApiKey).
 * @returns {boolean}
 */
export function isCodexAuthenticated() {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;

  // Direct auth.json check — handles auth_mode=apikey without relying on CLI behavior.
  try {
    const authJson = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'
    ));
    if (authJson?.auth_mode === 'apikey' && (authJson?.OPENAI_API_KEY || authJson?.apiKey)) {
      return true;
    }
  } catch { /* auth.json absent or malformed — fall through */ }

  // Use `codex login status` as the authoritative check for OAuth/device auth.
  try {
    const result = spawnSync('codex', ['login', 'status'], {
      stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── Claude credential helpers ──────────────────────────────────────────────

/**
 * Pre-approve an API key / setup token in ~/.claude.json so Claude Code skips
 * the interactive "Detected a custom API key" confirmation prompt.
 * Also marks onboarding as complete.
 * @param {string} keyOrToken
 */
export function approveApiKey(keyOrToken) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch {}
    if (!config.customApiKeyResponses) config.customApiKeyResponses = { approved: [], rejected: [] };
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    const keySuffix = keyOrToken.slice(-20);
    if (!config.customApiKeyResponses.approved.includes(keySuffix)) {
      config.customApiKeyResponses.approved.push(keySuffix);
    }
    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      try {
        const ver = execSync('claude --version 2>/dev/null', { encoding: 'utf8' }).trim();
        config.lastOnboardingVersion = ver;
      } catch { /* omit if claude binary not yet available */ }
    }
    if (!config.projects) config.projects = {};
    const projectPath = path.resolve(ZYLOS_DIR);
    if (!config.projects[projectPath]) config.projects[projectPath] = {};
    if (!config.projects[projectPath].hasTrustDialogAccepted) {
      config.projects[projectPath].hasTrustDialogAccepted = true;
      config.projects[projectPath].hasCompletedProjectOnboarding = true;
    }
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  } catch {}
}

/**
 * Save an Anthropic API key to ~/.claude/settings.json and pre-approve it.
 * @param {string} apiKey - The API key (sk-ant-api...)
 * @returns {boolean}
 */
export function saveApiKey(apiKey) {
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.ANTHROPIC_API_KEY = apiKey;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    return false;
  }
  approveApiKey(apiKey);
  process.env.ANTHROPIC_API_KEY = apiKey;
  return true;
}

/**
 * Write ANTHROPIC_API_KEY to ~/zylos/.env.
 * @param {string} apiKey
 */
export function saveApiKeyToEnv(apiKey) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    if (content.match(/^ANTHROPIC_API_KEY=.*$/m)) {
      content = content.replace(/^ANTHROPIC_API_KEY=.*$/m, `ANTHROPIC_API_KEY=${apiKey}`);
    } else {
      content = content.trimEnd() + `\n\n# Anthropic API key (set by zylos init)\nANTHROPIC_API_KEY=${apiKey}\n`;
    }
    fs.writeFileSync(envPath, content);
  } catch {}
}

/**
 * Save a Claude Code setup token to ~/.claude/settings.json and pre-approve it.
 * Removes any existing API key to avoid having both.
 * @param {string} token - The setup token (sk-ant-oat...)
 * @returns {boolean}
 */
export function saveSetupToken(token) {
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete settings.env.ANTHROPIC_API_KEY;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    return false;
  }
  approveApiKey(token);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return true;
}

/**
 * Write CLAUDE_CODE_OAUTH_TOKEN to ~/zylos/.env.
 * Removes any existing ANTHROPIC_API_KEY line to avoid having both.
 * @param {string} token
 */
export function saveSetupTokenToEnv(token) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    if (content.match(/^CLAUDE_CODE_OAUTH_TOKEN=.*$/m)) {
      content = content.replace(/^CLAUDE_CODE_OAUTH_TOKEN=.*$/m, `CLAUDE_CODE_OAUTH_TOKEN=${token}`);
    } else {
      content = content.trimEnd() + `\n\n# Claude Code setup token (set by zylos init)\nCLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
    }
    content = content.replace(/^# Anthropic API key \(set by zylos init\)\n/m, '');
    content = content.replace(/^ANTHROPIC_API_KEY=.*\n?/m, '');
    fs.writeFileSync(envPath, content);
  } catch {}
}

// ── Codex credential helpers ───────────────────────────────────────────────

/**
 * Write ~/.codex/config.toml with a comprehensive headless configuration that
 * suppresses all known interactive prompts (trust dialogs, model upgrade notices,
 * update checks, telemetry prompts, etc.).
 *
 * Called by both `zylos init` (Codex runtime) and `zylos runtime codex` so the
 * config is always present when switching to Codex.
 *
 * Existing [projects.*] trust entries in the file are preserved; top-level settings
 * and [notice] section are always written/overwritten for freshness.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 * @returns {boolean} true on success
 */
export function writeCodexConfig(projectDir) {
  const codexDir = path.join(os.homedir(), '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  const absProject = path.resolve(projectDir);
  try {
    // Preserve existing [projects.*] sections (other directories may already be trusted).
    let preservedProjects = '';
    try {
      const existing = fs.readFileSync(configPath, 'utf8');
      const projectMatches = existing.match(/^\[projects\.[^\]]+\][^\[]+/gm);
      if (projectMatches) {
        // Keep sections that are NOT the one we're about to write.
        const toKeep = projectMatches.filter(
          (s) => !s.includes(`"${absProject}"`) && !s.includes(`'${absProject}'`)
        );
        if (toKeep.length) preservedProjects = '\n' + toKeep.join('\n').trimEnd() + '\n';
      }
    } catch { /* new file — nothing to preserve */ }

    // Build the complete headless config.
    // All fields are verified against the installed Codex binary (v0.114.0).
    const config = [
      '# Codex headless config — written by zylos, do not edit manually.',
      '# Re-generated on each `zylos init` / `zylos runtime codex`.',
      '',
      '# Disable startup checks and telemetry',
      'check_for_update_on_startup = false',
      '# analytics: Codex v0.114.0 expects a struct here, not a boolean.',
      '# Omitting this field leaves analytics at default (no crash on startup).',
      '',
      '# Acknowledge the latest model NUX so the "Introducing GPT-X" dialog',
      '# is not shown on startup.  Update this when Codex ships a new default model.',
      'model_availability_nux = "gpt-5.4"',
      '',
      '# Suppress all known interactive notice dialogs',
      '[notice]',
      'hide_full_access_warning = true',
      'hide_world_writable_warning = true',
      'hide_rate_limit_model_nudge = true',
      'hide_gpt5_1_migration_prompt = true',
      '"hide_gpt-5.1-codex-max_migration_prompt" = true',
      '',
      '# Acknowledge known model migrations so no migration prompt appears',
      '[notice.model_migrations]',
      '"gpt-5.3-codex" = "gpt-5.4"',
      '',
      `# Trust the zylos project directory`,
      `[projects."${absProject}"]`,
      'trust_level = "trusted"',
    ].join('\n') + '\n';

    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, config + preservedProjects, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist an OpenAI API key to ~/.codex/auth.json (Codex's native credential store).
 * Also sets OPENAI_API_KEY in process.env for the current init process so that
 * isCodexAuthenticated() can detect it immediately without re-reading disk.
 *
 * We do NOT write to ~/zylos/.env — Codex CLI deliberately does not read OPENAI_API_KEY
 * from environment variables, so a key in .env has no effect on Codex. The canonical
 * credential store is auth.json.
 *
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @returns {boolean}
 */
export function saveCodexApiKey(apiKey) {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    fs.mkdirSync(codexDir, { recursive: true });
    let authContent = {};
    try { authContent = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { }
    authContent.auth_mode = 'apikey';
    authContent.OPENAI_API_KEY = apiKey;
    fs.writeFileSync(authPath, JSON.stringify(authContent, null, 2) + '\n', { mode: 0o600 });
    process.env.OPENAI_API_KEY = apiKey;
    return true;
  } catch {
    return false;
  }
}
