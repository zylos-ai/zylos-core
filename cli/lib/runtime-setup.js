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
import { execSync, spawnSync } from 'node:child_process';
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
    execSync(`npm install -g ${pkg}`, { stdio: 'pipe', timeout: 120000 });
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
 * Accepts env-var auth (OPENAI_API_KEY or CODEX_API_KEY) as well as native login.
 * @returns {boolean}
 */
export function isCodexAuthenticated() {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;
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
      } catch {
        config.lastOnboardingVersion = '2.1.59';
      }
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
 * Write OPENAI_API_KEY to ~/zylos/.env and ~/.codex/auth.json (native store).
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @returns {boolean}
 */
export function saveCodexApiKeyToEnv(apiKey) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    if (content.match(/^OPENAI_API_KEY=.*$/m)) {
      content = content.replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY=${apiKey}`);
    } else {
      content = content.trimEnd() + `\n\n# OpenAI API key for Codex (set by zylos init)\nOPENAI_API_KEY=${apiKey}\n`;
    }
    fs.writeFileSync(envPath, content);
    process.env.OPENAI_API_KEY = apiKey;

    // Also write to ~/.codex/auth.json so Codex reads the key natively at startup
    try {
      const codexDir = path.join(os.homedir(), '.codex');
      const authPath = path.join(codexDir, 'auth.json');
      fs.mkdirSync(codexDir, { recursive: true });
      let authContent = {};
      try { authContent = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
      authContent.auth_mode = 'apikey';
      authContent.OPENAI_API_KEY = apiKey;
      fs.writeFileSync(authPath, JSON.stringify(authContent, null, 2) + '\n', { mode: 0o600 });
    } catch { /* non-fatal — env var injection is the fallback */ }

    return true;
  } catch {
    return false;
  }
}
