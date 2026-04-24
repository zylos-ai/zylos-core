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
import { fileURLToPath } from 'node:url';
import { ZYLOS_DIR } from './config.js';
import { commandExists } from './shell-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function upsertEnvValue(content, key, value, comment = null) {
  const line = `${key}=${value}`;
  if (content.match(new RegExp(`^${key}=.*$`, 'm'))) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const prefix = comment ? `\n\n# ${comment}\n` : '\n';
  return content.trimEnd() + `${prefix}${line}\n`;
}

export function isValidBaseUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host;
  } catch {
    return false;
  }
}

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
    content = upsertEnvValue(content, 'ANTHROPIC_API_KEY', apiKey, 'Anthropic API key (set by zylos init)');
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
    content = upsertEnvValue(content, 'CLAUDE_CODE_OAUTH_TOKEN', token, 'Claude Code setup token (set by zylos init)');
    content = content.replace(/^# Anthropic API key \(set by zylos init\)\n/m, '');
    content = content.replace(/^\s*ANTHROPIC_API_KEY\s*=.*\n?/m, '');
    fs.writeFileSync(envPath, content);
  } catch {}
}

/**
 * Set ANTHROPIC_BASE_URL in process.env for the current process.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveClaudeBaseUrl(baseUrl) {
  try {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

/**
 * Write ANTHROPIC_BASE_URL to Claude settings.json.
 * @param {string} baseUrl
 * @returns {boolean}
 */
function saveClaudeBaseUrlToSettings(baseUrl) {
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.ANTHROPIC_BASE_URL = baseUrl;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Write ANTHROPIC_BASE_URL to Claude settings.json and ~/zylos/.env.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveClaudeBaseUrlToSettingsAndEnv(baseUrl) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    if (!saveClaudeBaseUrlToSettings(baseUrl)) return false;
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'ANTHROPIC_BASE_URL', baseUrl, 'Anthropic base URL for Claude Code (set by zylos init)');
    fs.writeFileSync(envPath, content);
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

// ── Codex credential helpers ───────────────────────────────────────────────

/**
 * Render project-level .codex/config.toml with headless configuration.
 *
 * Contains settings required for zylos unattended operation: interactive prompt
 * suppression, feature flags, and model migration acknowledgements. These are
 * project requirements, not user preferences.
 *
 * Written to <projectDir>/.codex/config.toml (Codex project-level config).
 *
 * @returns {string}
 */
export function renderCodexProjectConfig() {
  return [
    '# Zylos project-level Codex config — written by zylos, do not edit manually.',
    '# Re-generated on each `zylos init` / `zylos runtime codex`.',
    '# Headless operation: suppress all interactive prompts.',
    '',
    '# Disable startup checks',
    'check_for_update_on_startup = false',
    '',
    '# Acknowledge the latest model NUX so the "Introducing GPT-X" dialog',
    '# is not shown on startup.  Update this when Codex ships a new default model.',
    'model_availability_nux = "gpt-5.4"',
    '',
    '# Enable Codex features required by Zylos runtime workflows.',
    '[features]',
    'multi_agent = true',
    'codex_hooks = true',
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
  ].join('\n') + '\n';
}

export function renderCodexHooksConfig(opts = {}) {
  const guardScriptPath = opts.guardScriptPath || path.join(__dirname, 'codex-path-guard.js');
  const guardCommand = `node "${guardScriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: guardCommand,
              timeout: 5,
              statusMessage: 'Checking workspace scope',
            },
          ],
        },
      ],
      PermissionRequest: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: guardCommand,
              timeout: 5,
              statusMessage: 'Checking workspace scope',
            },
          ],
        },
      ],
    },
  }, null, 2) + '\n';
}

/**
 * Render global ~/.codex/config.toml with user/environment-level settings.
 *
 * Contains only trust declarations and optional base URL override.
 * Existing [projects.*] trust entries are preserved; the zylos project trust
 * entry is always regenerated.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 * @param {string} existingContent - Existing global config.toml contents (optional)
 * @param {{ openaiBaseUrl?: string }} opts - Optional Codex config overrides
 * @returns {string}
 */
export function renderCodexGlobalConfig(projectDir, existingContent = '', opts = {}) {
  const absProject = path.resolve(projectDir);
  const openaiBaseUrl = opts.openaiBaseUrl || process.env.OPENAI_BASE_URL || '';

  let preservedProjects = '';
  const projectMatches = existingContent.match(/^\[projects\.[^\]]+\][^\[]+/gm);
  if (projectMatches) {
    const toKeep = projectMatches.filter(
      (s) => !s.includes(`"${absProject}"`) && !s.includes(`'${absProject}'`)
    );
    if (toKeep.length) preservedProjects = '\n' + toKeep.join('\n').trimEnd() + '\n';
  }

  const config = [
    '# Codex global config — written by zylos, do not edit manually.',
    '# Re-generated on each `zylos init` / `zylos runtime codex`.',
    ...(openaiBaseUrl ? ['', '# Use a custom OpenAI-compatible base URL', `openai_base_url = "${openaiBaseUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`] : []),
    '',
    '# Trust the zylos project directory',
    `[projects."${absProject}"]`,
    'trust_level = "trusted"',
  ].join('\n') + '\n';

  return config + preservedProjects;
}

/**
 * Write Codex configuration to both project-level and global locations.
 *
 * - Project config (<projectDir>/.codex/config.toml): headless settings,
 *   features, notice suppression — required for zylos unattended operation.
 * - Global config (~/.codex/config.toml): trust declarations, optional
 *   base URL override.
 *
 * Called by both `zylos init` (Codex runtime) and `zylos runtime codex` so the
 * config is always present when switching to Codex.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 * @returns {boolean} true on success
 */
export function writeCodexConfig(projectDir, opts = {}) {
  try {
    // Write project-level config
    const projectCodexDir = path.join(path.resolve(projectDir), '.codex');
    fs.mkdirSync(projectCodexDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectCodexDir, 'config.toml'),
      renderCodexProjectConfig(),
      'utf8'
    );
    fs.writeFileSync(
      path.join(projectCodexDir, 'hooks.json'),
      renderCodexHooksConfig(opts),
      'utf8'
    );

    // Write global config
    const globalCodexDir = path.join(os.homedir(), '.codex');
    const globalConfigPath = path.join(globalCodexDir, 'config.toml');
    let existing = '';
    try {
      existing = fs.readFileSync(globalConfigPath, 'utf8');
    } catch { /* new file — nothing to preserve */ }
    fs.mkdirSync(globalCodexDir, { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      renderCodexGlobalConfig(projectDir, existing, opts),
      'utf8'
    );

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

/**
 * Write OPENAI_API_KEY to ~/zylos/.env for runtime processes that still read it there.
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @returns {boolean}
 */
export function saveCodexApiKeyToEnv(apiKey) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'OPENAI_API_KEY', apiKey, 'OpenAI API key for Codex (set by zylos init)');
    fs.writeFileSync(envPath, content);
    process.env.OPENAI_API_KEY = apiKey;
    return true;
  } catch {
    return false;
  }
}

/**
 * Set OPENAI_BASE_URL in process.env for the current process.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveCodexBaseUrl(baseUrl) {
  try {
    process.env.OPENAI_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

/**
 * Write OPENAI_BASE_URL to ~/zylos/.env.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveCodexBaseUrlToEnv(baseUrl) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'OPENAI_BASE_URL', baseUrl, 'OpenAI base URL for Codex (set by zylos init)');
    fs.writeFileSync(envPath, content);
    process.env.OPENAI_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}
