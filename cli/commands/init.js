/**
 * zylos init - Initialize Zylos environment
 *
 * Sets up the directory structure, checks prerequisites,
 * syncs Core Skills, deploys templates, and starts services.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { ZYLOS_DIR, SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, COMPONENTS_FILE, BIN_DIR, HTTP_DIR, CADDYFILE, CADDY_BIN, getZylosConfig, updateZylosConfig } from '../lib/config.js';
import { generateManifest, saveManifest } from '../lib/manifest.js';
import { prompt, promptYesNo, promptChoice, promptSecret } from '../lib/prompts.js';
import { bold, dim, green, red, yellow, cyan, bgGreen, success, error, warn, heading } from '../lib/colors.js';
import { commandExists } from '../lib/shell-utils.js';

// Source directories (shipped with zylos package)
const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..');
const CORE_SKILLS_SRC = path.join(PACKAGE_ROOT, 'skills');
const TEMPLATES_SRC = path.join(PACKAGE_ROOT, 'templates');

// Minimum Node.js version
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 20;

/**
 * Read service names from the deployed ecosystem.config.cjs.
 * Single source of truth — no hardcoded list needed.
 */
function getCoreServiceNames() {
  const ecosystemPath = path.join(ZYLOS_DIR, 'pm2', 'ecosystem.config.cjs');
  if (!fs.existsSync(ecosystemPath)) return [];
  try {
    const require = createRequire(import.meta.url);
    // Clear cache so re-reads pick up updates from deployTemplates()
    delete require.cache[ecosystemPath];
    const ecosystem = require(ecosystemPath);
    return ecosystem.apps.map((app) => app.name);
  } catch {
    return [];
  }
}

// ── Prerequisite checks ─────────────────────────────────────────

function checkNodeVersion() {
  const version = process.version;
  const parts = version.slice(1).split('.').map(Number);
  const ok = parts[0] > MIN_NODE_MAJOR ||
    (parts[0] === MIN_NODE_MAJOR && parts[1] >= MIN_NODE_MINOR);
  return { version, ok, required: `>=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0` };
}

function installGlobalPackage(pkg) {
  try {
    execSync(`npm install -g ${pkg}`, { stdio: 'pipe', timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}

function installSystemPackage(pkg) {
  const platform = process.platform;
  const sudo = process.getuid?.() === 0 ? '' : 'sudo ';

  if (platform === 'darwin') {
    try {
      execSync(`brew install ${pkg}`, { stdio: 'pipe', timeout: 120000 });
      return true;
    } catch {
      return false;
    }
  }

  // Linux: try apt-get first, then yum
  const cmds = [
    [`${sudo}apt-get update`, `${sudo}apt-get install -y ${pkg}`],
    [`${sudo}yum install -y ${pkg}`],
  ];

  for (const sequence of cmds) {
    try {
      for (const cmd of sequence) {
        execSync(cmd, { stdio: 'pipe', timeout: 120000 });
      }
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}

/**
 * Ensure ~/.local/bin is in the user's shell profile.
 * Detects shell from $SHELL and writes to the appropriate rc file.
 * Returns the profile path if modified, null otherwise.
 */
function ensureLocalBinInProfile() {
  const homedir = os.homedir();
  const shell = (process.env.SHELL || '').split('/').pop();
  const pathLine = 'export PATH="$HOME/.local/bin:$PATH"';

  // Map shell to profile file
  const profileMap = {
    zsh: '.zshrc',
    bash: '.bashrc',
    fish: null, // fish uses different syntax
    sh: '.profile',
  };

  const profileName = profileMap[shell] || '.profile';
  if (!profileName) return null; // unsupported shell (fish)

  const profilePath = path.join(homedir, profileName);

  // Check if already present
  try {
    const content = fs.readFileSync(profilePath, 'utf8');
    if (content.includes('.local/bin')) return null; // already there
  } catch {
    // File doesn't exist — we'll create it
  }

  try {
    fs.appendFileSync(profilePath, `\n# Added by zylos init\n${pathLine}\n`);
    return `~/${profileName}`;
  } catch {
    return null;
  }
}

/**
 * Save the current shell PATH to .env so PM2 services can use it.
 * Updates SYSTEM_PATH= line if exists, appends if not.
 */
function saveSystemPath(envPath) {
  const currentPath = process.env.PATH || '';
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // .env doesn't exist yet
  }

  const line = `SYSTEM_PATH=${currentPath}`;
  if (content.includes('SYSTEM_PATH=')) {
    content = content.replace(/^SYSTEM_PATH=.*$/m, line);
  } else {
    content = content.trimEnd() + '\n\n# System PATH captured by zylos init (used by PM2 services)\n' + line + '\n';
  }
  fs.writeFileSync(envPath, content);
}

// ── Timezone configuration ───────────────────────────────────

// Common timezones grouped for selection
const COMMON_TIMEZONES = [
  { label: 'Asia/Shanghai (UTC+8)', value: 'Asia/Shanghai' },
  { label: 'Asia/Tokyo (UTC+9)', value: 'Asia/Tokyo' },
  { label: 'Asia/Singapore (UTC+8)', value: 'Asia/Singapore' },
  { label: 'Asia/Kolkata (UTC+5:30)', value: 'Asia/Kolkata' },
  { label: 'America/New_York (UTC-5)', value: 'America/New_York' },
  { label: 'America/Chicago (UTC-6)', value: 'America/Chicago' },
  { label: 'America/Los_Angeles (UTC-8)', value: 'America/Los_Angeles' },
  { label: 'Europe/London (UTC+0)', value: 'Europe/London' },
  { label: 'Europe/Berlin (UTC+1)', value: 'Europe/Berlin' },
  { label: 'Australia/Sydney (UTC+11)', value: 'Australia/Sydney' },
  { label: 'Pacific/Auckland (UTC+13)', value: 'Pacific/Auckland' },
  { label: 'UTC', value: 'UTC' },
];

/**
 * Detect the system timezone.
 * @returns {string} IANA timezone name
 */
function detectSystemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Validate an IANA timezone string.
 * @param {string} tz
 * @returns {boolean}
 */
function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current TZ value from .env.
 * @returns {string|null} TZ value or null if not set
 */
function readEnvTimezone() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^TZ=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Write timezone to .env file. Updates existing TZ= line or adds one.
 * @param {string} tz - IANA timezone name
 */
function writeEnvTimezone(tz) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  if (content.match(/^TZ=.*$/m)) {
    content = content.replace(/^TZ=.*$/m, `TZ=${tz}`);
  } else {
    content = content.trimEnd() + `\nTZ=${tz}\n`;
  }
  fs.writeFileSync(envPath, content);
}

/**
 * Interactive timezone configuration.
 * Auto-detects system timezone and asks user to confirm or select another.
 * On re-init, shows current value and skips prompt.
 *
 * @param {boolean} skipConfirm - Skip interactive prompts (--yes flag)
 * @param {boolean} isReinit - Whether this is a re-init of an existing installation
 * @param {string|null} resolvedTz - Timezone from CLI flag or env var (already validated)
 * @param {boolean} quiet - Suppress output (--quiet flag)
 */
async function configureTimezone(skipConfirm, isReinit, resolvedTz = null, quiet = false) {
  // CLI flag or env var provided — use directly
  if (resolvedTz) {
    writeEnvTimezone(resolvedTz);
    if (!quiet) console.log(`  ${success(`Timezone: ${bold(resolvedTz)}`)}`);
    return;
  }

  const currentTz = readEnvTimezone();

  // Re-init with valid non-default timezone: just display it
  if (isReinit && currentTz && isValidTimezone(currentTz)) {
    if (!quiet) console.log(`  ${success(`Timezone: ${bold(currentTz)}`)}`);
    return;
  }

  // Non-interactive mode: use detected timezone
  if (skipConfirm) {
    const detected = detectSystemTimezone();
    writeEnvTimezone(detected);
    if (!quiet) console.log(`  ${success(`Timezone: ${bold(detected)}`)}`);
    return;
  }

  const detected = detectSystemTimezone();
  const useDetected = await promptYesNo(`  Detected timezone: ${bold(detected)}. Is this correct? [Y/n]: `, true);

  if (useDetected) {
    writeEnvTimezone(detected);
    console.log(`  ${success(`Timezone: ${bold(detected)}`)}`);
    return;
  }

  // Show common timezone list
  console.log(`\n  ${heading('Select timezone:')}`);
  for (let i = 0; i < COMMON_TIMEZONES.length; i++) {
    console.log(`    ${i + 1}) ${COMMON_TIMEZONES[i].label}`);
  }
  console.log(`    ${COMMON_TIMEZONES.length + 1}) Other (enter manually)`);

  while (true) {
    const choice = await prompt(`\n  Enter number [1-${COMMON_TIMEZONES.length + 1}]: `);
    const num = parseInt(choice, 10);

    if (num >= 1 && num <= COMMON_TIMEZONES.length) {
      const tz = COMMON_TIMEZONES[num - 1].value;
      writeEnvTimezone(tz);
      console.log(`  ${success(`Timezone: ${bold(tz)}`)}`);
      return;
    }

    if (num === COMMON_TIMEZONES.length + 1) {
      while (true) {
        const manual = await prompt('  Enter IANA timezone (e.g., America/Denver): ');
        if (!manual) continue;
        if (isValidTimezone(manual)) {
          writeEnvTimezone(manual);
          console.log(`  ${success(`Timezone: ${bold(manual)}`)}`);
          return;
        }
        console.log(`  ${error(`Invalid timezone: "${manual}". Try again.`)}`);
      }
    }

    console.log(`  Please enter a number between 1 and ${COMMON_TIMEZONES.length + 1}.`);
  }
}

/**
 * Ensure ~/zylos/bin is in the user's shell PATH.
 * Detects the user's shell and appends to the appropriate rc file.
 * Idempotent: uses a marker comment to avoid duplicates.
 *
 * @returns {boolean} true if PATH was updated, false if already configured
 */
function ensureBinInPath() {
  // Already in PATH — nothing to do
  if ((process.env.PATH || '').split(':').includes(BIN_DIR)) {
    return false;
  }

  // Update current process PATH immediately so child processes (hooks,
  // services) can find binaries without needing a new shell session
  process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;

  const home = process.env.HOME;
  const marker = '# zylos-managed: bin PATH';
  const snippet = `\n${marker}\nexport PATH="${BIN_DIR}:$PATH"\n`;

  // Write to ~/.profile (sourced by login shells AND non-interactive shells
  // via .profile → .bashrc chain). On Ubuntu, .bashrc has an early-exit guard
  // for non-interactive shells, so appending to .bashrc alone won't work for
  // tools like Claude Code that spawn non-interactive bash processes.
  const profileFile = path.join(home, '.profile');
  let profileUpdated = false;
  try {
    const content = fs.readFileSync(profileFile, 'utf8');
    if (!content.includes(marker)) {
      fs.appendFileSync(profileFile, snippet);
      profileUpdated = true;
    }
  } catch {
    fs.appendFileSync(profileFile, snippet);
    profileUpdated = true;
  }

  // Also write to shell rc file for interactive shells (zsh uses .zshrc,
  // bash interactive shells source .bashrc after the guard)
  const shell = process.env.SHELL || '/bin/bash';
  let rcFile;
  if (shell.endsWith('/zsh')) {
    rcFile = path.join(home, '.zshrc');
  } else if (shell.endsWith('/fish')) {
    return profileUpdated;
  } else {
    rcFile = path.join(home, '.bashrc');
  }

  try {
    const content = fs.readFileSync(rcFile, 'utf8');
    if (content.includes(marker)) return profileUpdated;
  } catch {
    // rc file doesn't exist — we'll create/append
  }

  fs.appendFileSync(rcFile, snippet);
  return true;
}

/**
 * Check if Claude Code is authenticated.
 * @returns {boolean}
 */
function isClaudeAuthenticated() {
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
 * Save an Anthropic API key to ~/.claude/settings.json and process.env.
 * Does NOT write to ~/zylos/.env here — that happens after template
 * deployment via saveApiKeyToEnv() to avoid creating a partial .env
 * that blocks template deployment on fresh installs.
 *
 * @param {string} apiKey - The API key (sk-ant-xxx)
 * @returns {boolean} true if saved successfully
 */
/**
 * Verify an Anthropic API key by making a lightweight API call.
 * Sends an intentionally empty request — a valid key returns 400 (bad request),
 * an invalid key returns 401 (unauthorized).
 *
 * @param {string} apiKey - The API key to verify
 * @returns {Promise<boolean>} true if key is valid
 */
function verifyApiKey(apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 10000,
    }, (res) => {
      res.resume(); // drain response
      // 401 = invalid key, anything else (400, 200, etc.) = key is valid
      resolve(res.statusCode !== 401);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write('{}');
    req.end();
  });
}

function saveApiKey(apiKey) {
  // 1. Write to ~/.claude/settings.json so Claude Code picks it up
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.ANTHROPIC_API_KEY = apiKey;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    console.log(`  ${error(`Failed to write settings.json: ${err.message}`)}`);
    return false;
  }

  // 2. Pre-approve key in ~/.claude.json so Claude skips the interactive
  //    "Detected a custom API key" confirmation prompt on startup
  approveApiKey(apiKey);

  // 3. Set in current process so subsequent checks pass
  process.env.ANTHROPIC_API_KEY = apiKey;

  return true;
}

/**
 * Pre-approve an API key in ~/.claude.json so Claude Code skips
 * the interactive "Detected a custom API key" confirmation prompt.
 * Also marks onboarding as complete to prevent the login screen
 * from blocking prompt processing on fresh installs.
 * @param {string} apiKey - The API key to approve
 */
function approveApiKey(apiKey) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch {}
    if (!config.customApiKeyResponses) config.customApiKeyResponses = { approved: [], rejected: [] };
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    // Claude Code stores last 20 chars of the key for matching
    const keySuffix = apiKey.slice(-20);
    if (!config.customApiKeyResponses.approved.includes(keySuffix)) {
      config.customApiKeyResponses.approved.push(keySuffix);
    }
    // Mark onboarding complete so Claude doesn't show login screen
    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      try {
        const ver = execSync('claude --version 2>/dev/null', { encoding: 'utf8' }).trim();
        config.lastOnboardingVersion = ver;
      } catch {
        config.lastOnboardingVersion = '2.1.59';
      }
    }
    // Pre-accept workspace trust dialog for the zylos project directory
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
 * Write ANTHROPIC_API_KEY to ~/zylos/.env.
 * Called after template deployment to ensure .env has the full template content.
 *
 * @param {string} apiKey - The API key
 */
function saveApiKeyToEnv(apiKey) {
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
  } catch (err) {
    console.log(`  ${warn(`Could not write API key to .env: ${err.message}`)}`);
  }
}

/**
 * Save a setup token to ~/.claude/settings.json and process.env.
 * Does NOT write to ~/zylos/.env here — that happens after template
 * deployment via saveSetupTokenToEnv().
 *
 * @param {string} token - The setup token (sk-ant-oat...)
 * @returns {boolean} true if saved successfully
 */
function saveSetupToken(token) {
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    // Remove API key if set — avoid having both
    delete settings.env.ANTHROPIC_API_KEY;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    console.log(`  ${error(`Failed to write settings.json: ${err.message}`)}`);
    return false;
  }

  // Pre-approve in ~/.claude.json (onboarding + trust)
  approveApiKey(token);

  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;

  return true;
}

/**
 * Write CLAUDE_CODE_OAUTH_TOKEN to ~/zylos/.env.
 * Called after template deployment to ensure .env has the full template content.
 *
 * @param {string} token - The setup token
 */
function saveSetupTokenToEnv(token) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    if (content.match(/^CLAUDE_CODE_OAUTH_TOKEN=.*$/m)) {
      content = content.replace(/^CLAUDE_CODE_OAUTH_TOKEN=.*$/m, `CLAUDE_CODE_OAUTH_TOKEN=${token}`);
    } else {
      content = content.trimEnd() + `\n\n# Claude Code setup token (set by zylos init)\nCLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
    }
    // Remove ANTHROPIC_API_KEY if present — avoid having both
    content = content.replace(/^# Anthropic API key \(set by zylos init\)\n/m, '');
    content = content.replace(/^ANTHROPIC_API_KEY=.*\n?/m, '');
    fs.writeFileSync(envPath, content);
  } catch (err) {
    console.log(`  ${warn(`Could not write setup token to .env: ${err.message}`)}`);
  }
}

/**
 * Verify a setup token by running `claude -p "hi" --max-turns 1`.
 * The token must already be saved (via saveSetupToken) so claude picks it up.
 *
 * @returns {{ valid: boolean, authError?: boolean, message?: string }}
 */
function verifySetupToken() {
  try {
    const result = spawnSync('claude', ['-p', 'hi', '--max-turns', '1'], {
      timeout: 30000,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
      return { valid: true };
    }

    const output = ((result.stdout?.toString() || '') + (result.stderr?.toString() || '')).trim();
    const lower = output.toLowerCase();
    const isAuthError = lower.includes('401') || lower.includes('unauthorized') ||
      lower.includes('authentication') || lower.includes('invalid') ||
      lower.includes('expired');

    return { valid: false, authError: isAuthError, message: output };
  } catch (err) {
    return { valid: false, authError: false, message: err.message };
  }
}

/**
 * Undo saveSetupToken(): remove CLAUDE_CODE_OAUTH_TOKEN from
 * ~/.claude/settings.json and the current process environment.
 */
function rollbackSetupToken() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.env) {
      delete settings.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    console.error(`  ${warn(`Could not rollback setup token from settings.json: ${err.message}`)}`);
  }

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/**
 * Check if Claude bypass permissions needs first-time acceptance.
 * Returns true if bypass is enabled and hasn't been accepted yet.
 */
function needsBypassAcceptance() {
  // Check if bypass is disabled in .env
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^CLAUDE_BYPASS_PERMISSIONS=(.+)$/m);
    if (match && match[1].trim() === 'false') return false;
  } catch {}

  // Check if already pre-accepted via settings.json
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.skipDangerousModePermissionPrompt) return false;
  } catch {}

  // Check if already accepted (tmux session with Claude running)
  try {
    execSync('tmux has-session -t claude-main 2>/dev/null', { stdio: 'pipe' });
    const paneContent = execSync('tmux capture-pane -t claude-main -p 2>/dev/null', { encoding: 'utf8' });
    if (paneContent.includes('>') || paneContent.includes('Claude')) {
      return false;
    }
  } catch {}

  return true;
}

/**
 * Pre-accept Claude Code terms and bypass permissions prompt.
 * Writes acceptance state to config files so Claude starts without manual confirmation.
 */
function preAcceptClaudeTerms() {
  const homedir = os.homedir();
  let changed = false;

  // 1. Set hasCompletedOnboarding in ~/.claude.json
  const claudeJsonPath = path.join(homedir, '.claude.json');
  let claudeJson = {};
  try {
    claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch {}
  if (!claudeJson.hasCompletedOnboarding) {
    claudeJson.hasCompletedOnboarding = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
    changed = true;
  }

  // 2. Set skipDangerousModePermissionPrompt in ~/.claude/settings.json
  const claudeDir = path.join(homedir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {}
  if (!settings.skipDangerousModePermissionPrompt) {
    settings.skipDangerousModePermissionPrompt = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    changed = true;
  }

  return changed;
}

/**
 * Guide user through first-time Claude bypass permissions acceptance.
 */
async function guideBypassAcceptance() {
  console.log(`\n${heading('Setting up Claude Code...')}`);

  // Stop activity-monitor to prevent restart loop
  try { execSync('pm2 stop activity-monitor', { stdio: 'pipe' }); } catch {}

  // Kill existing session if stuck
  try { execSync('tmux kill-session -t claude-main 2>/dev/null', { stdio: 'pipe' }); } catch {}

  // Create new tmux session with Claude
  try {
    const sandboxEnv = process.env.IS_SANDBOX ? '-e "IS_SANDBOX=1" ' : '';
    const apiKeyEnv = process.env.ANTHROPIC_API_KEY ? `-e "ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}" ` : '';
    execSync(`tmux new-session -d -s claude-main ${sandboxEnv}${apiKeyEnv}"cd ${ZYLOS_DIR} && claude --dangerously-skip-permissions"`, { stdio: 'pipe' });
    // Configure status bar with detach hint
    try {
      execSync('tmux set-option -t claude-main status-right " Ctrl+B d = detach " 2>/dev/null', { stdio: 'pipe' });
      execSync('tmux set-option -t claude-main status-right-style "fg=black,bg=yellow" 2>/dev/null', { stdio: 'pipe' });
    } catch {}
  } catch (err) {
    console.log(`  ${warn(`Failed to create tmux session: ${err.message}`)}`);
    try { execSync('pm2 start activity-monitor', { stdio: 'pipe' }); } catch {}
    return;
  }

  console.log('  Claude Code requires a one-time confirmation for autonomous mode.');
  console.log('  Please run the following command in another terminal:\n');
  console.log(`    ${bold('zylos attach')}\n`);
  console.log('  Then select "Yes, I accept" and press Ctrl+B d to detach.\n');

  await promptYesNo('Press Enter after you have accepted the prompt: ', true);

  // Restart activity-monitor
  try { execSync('pm2 start activity-monitor', { stdio: 'pipe' }); } catch {}
  console.log(`  ${success('Claude Code configured')}`);
}

// ── Installation state detection ────────────────────────────────

/**
 * Detect the current installation state.
 * @returns {'fresh'|'incomplete'|'complete'}
 */
function detectInstallState() {
  if (!fs.existsSync(ZYLOS_DIR)) return 'fresh';

  const markers = [CONFIG_DIR, SKILLS_DIR, COMPONENTS_FILE];
  const existing = markers.filter((m) => fs.existsSync(m));

  if (existing.length === 0) return 'fresh';
  if (existing.length === markers.length) return 'complete';
  return 'incomplete';
}

// ── State reset ─────────────────────────────────────────────────

/**
 * Reset managed state for a fresh install.
 * Removes config, skills, and components while preserving user data
 * (memory/, logs/, .env, CLAUDE.md).
 */
function resetManagedState() {
  // Stop PM2 services managed by zylos
  const serviceNames = getCoreServiceNames();
  for (const name of serviceNames) {
    try { execSync(`pm2 delete "${name}" 2>/dev/null`, { stdio: 'pipe' }); } catch { /* */ }
  }

  // Remove managed directories
  for (const dir of [SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, path.join(ZYLOS_DIR, 'pm2')]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ── Directory structure ─────────────────────────────────────────

function createDirectoryStructure() {
  const dirs = [
    ZYLOS_DIR,
    SKILLS_DIR,
    CONFIG_DIR,
    COMPONENTS_DIR,
    LOCKS_DIR,
    BIN_DIR,
    HTTP_DIR,
    path.join(HTTP_DIR, 'public'),
    path.join(ZYLOS_DIR, 'memory'),
    path.join(ZYLOS_DIR, 'workspace'),
    path.join(ZYLOS_DIR, 'logs'),
    path.join(ZYLOS_DIR, 'pm2'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(COMPONENTS_FILE)) {
    fs.writeFileSync(COMPONENTS_FILE, JSON.stringify({}, null, 2));
  }
}

// ── Templates ───────────────────────────────────────────────────

/**
 * Recursively copy source files into dest directory, but only when missing.
 * Preserves user-managed files while ensuring nested template dirs exist.
 */
function copyMissingTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyMissingTree(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Deploy template files to the zylos directory.
 * - ecosystem.config.cjs: always updated (managed by zylos-core)
 * - .env, CLAUDE.md, memory/*: only created if missing (user-managed)
 */
function deployTemplates() {
  if (!fs.existsSync(TEMPLATES_SRC)) return;

  // ecosystem.config.cjs — always update (source of truth for service definitions)
  const pm2Dir = path.join(ZYLOS_DIR, 'pm2');
  fs.mkdirSync(pm2Dir, { recursive: true });
  const ecosystemSrc = path.join(TEMPLATES_SRC, 'pm2', 'ecosystem.config.cjs');
  if (fs.existsSync(ecosystemSrc)) {
    fs.copyFileSync(ecosystemSrc, path.join(pm2Dir, 'ecosystem.config.cjs'));
  }

  // .env — create from template if missing
  const envSrc = path.join(TEMPLATES_SRC, '.env.example');
  const envDest = path.join(ZYLOS_DIR, '.env');
  if (fs.existsSync(envSrc) && !fs.existsSync(envDest)) {
    fs.copyFileSync(envSrc, envDest);
    console.log(`  ${success('Created .env from template')}`);
  }

  // Always save current shell PATH to .env (for PM2 services)
  saveSystemPath(envDest);

  // CLAUDE.md — only create if missing
  const claudeMdSrc = path.join(TEMPLATES_SRC, 'CLAUDE.md');
  const claudeMdDest = path.join(ZYLOS_DIR, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc) && !fs.existsSync(claudeMdDest)) {
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
    console.log(`  ${success('Created CLAUDE.md from template')}`);
  }

  // memory/ templates — only create missing files
  const memorySrc = path.join(TEMPLATES_SRC, 'memory');
  const memoryDest = path.join(ZYLOS_DIR, 'memory');
  if (fs.existsSync(memorySrc)) {
    copyMissingTree(memorySrc, memoryDest);
  }

  // .claude/ project settings (hooks, etc.) — only create missing files
  const claudeSrc = path.join(TEMPLATES_SRC, '.claude');
  const claudeDest = path.join(ZYLOS_DIR, '.claude');
  if (fs.existsSync(claudeSrc)) {
    copyMissingTree(claudeSrc, claudeDest);
  }
}

// ── Core Skills sync ────────────────────────────────────────────

/**
 * Recursively copy source files into dest directory.
 * Overwrites existing files, adds new files, preserves extra files
 * in dest (e.g., node_modules, data directories not in source).
 */
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Sync Core Skills from the zylos package to SKILLS_DIR.
 * Always updates source files from package (core skills are managed
 * by zylos-core, like ecosystem.config.cjs). Preserves node_modules
 * and any extra files not in the package source.
 */
function syncCoreSkills() {
  if (!fs.existsSync(CORE_SKILLS_SRC)) {
    return { installed: [], updated: [], error: 'Core Skills source not found' };
  }

  const installed = [];
  const updated = [];

  const entries = fs.readdirSync(CORE_SKILLS_SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(CORE_SKILLS_SRC, entry.name);
    const destDir = path.join(SKILLS_DIR, entry.name);
    const isNew = !fs.existsSync(destDir);

    try {
      copyTree(srcDir, destDir);
      const manifest = generateManifest(destDir);
      saveManifest(destDir, manifest);
      (isNew ? installed : updated).push(entry.name);
    } catch {
      console.log(`  ${warn(`Failed to sync ${bold(entry.name)}`)}`);
    }
  }

  return { installed, updated };
}

// ── Skill dependencies ──────────────────────────────────────────

/**
 * Install npm dependencies for all skills that need them.
 */
function installSkillDependencies() {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const pkgPath = path.join(skillDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;

      console.log(`  ${cyan(`Installing ${bold(entry.name)} dependencies...`)}`);
      execSync('npm install --production', {
        cwd: skillDir,
        stdio: 'pipe',
        timeout: 120000,
      });
    } catch {
      console.log(`  ${warn(`Failed to install ${bold(entry.name)} dependencies`)}`);
    }
  }
}

/**
 * Ensure a web-console password exists in .env.
 * Reads from ZYLOS_WEB_PASSWORD (new name), falls back to WEB_CONSOLE_PASSWORD (legacy).
 * Generates a random 16-char password if not already set.
 * Idempotent — safe to run on repeated init.
 *
 * @param {string|null} explicitPassword - Password from --web-password flag or env var
 * @returns {string} The password (existing or newly generated)
 */
function ensureWebConsolePassword(explicitPassword = null) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  const newKey = 'ZYLOS_WEB_PASSWORD';
  const oldKey = 'WEB_CONSOLE_PASSWORD';

  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { return ''; }

  // Explicit password from flag/env: write it
  if (explicitPassword) {
    if (content.match(new RegExp(`^${newKey}=.*$`, 'm'))) {
      content = content.replace(new RegExp(`^${newKey}=.*$`, 'm'), `${newKey}=${explicitPassword}`);
    } else if (content.match(new RegExp(`^${oldKey}=.*$`, 'm'))) {
      content = content.replace(new RegExp(`^${oldKey}=.*$`, 'm'), `${newKey}=${explicitPassword}`);
    } else {
      content = content.trimEnd() + `\n# Web Console password\n${newKey}=${explicitPassword}\n`;
    }
    fs.writeFileSync(envPath, content);
    return explicitPassword;
  }

  // Check new name first, then legacy
  const matchNew = content.match(new RegExp(`^${newKey}=(.+)`, 'm'));
  if (matchNew) return matchNew[1].trim();

  const matchOld = content.match(new RegExp(`^${oldKey}=(.+)`, 'm'));
  if (matchOld) return matchOld[1].trim();

  // Generate new password
  const password = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  const entry = `\n# Web Console password\n${newKey}=${password}\n`;
  fs.writeFileSync(envPath, content.trimEnd() + entry);
  return password;
}

/**
 * Migrate WEB_CONSOLE_PASSWORD → ZYLOS_WEB_PASSWORD in .env.
 * If old name found and new name not present, rename in-place.
 */
function migrateWebConsolePassword() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { return; }

  const hasOld = /^WEB_CONSOLE_PASSWORD=(.+)$/m.test(content);
  const hasNew = /^ZYLOS_WEB_PASSWORD=/m.test(content);

  if (hasOld && !hasNew) {
    content = content.replace(/^WEB_CONSOLE_PASSWORD=/m, 'ZYLOS_WEB_PASSWORD=');
    // Update comment if present
    content = content.replace(/^# Web Console password \(auto-generated\)$/m, '# Web Console password');
    fs.writeFileSync(envPath, content);
  }
}

/**
 * Get the first non-loopback IPv4 address (for display purposes).
 * @returns {string} IP address or empty string if none found
 */
function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '';
}

/**
 * Print web console access info (URL + password).
 * Called at the end of init to show the user how to access.
 * Displayed prominently so the user doesn't miss the password.
 * Always shown even in quiet mode (essential output).
 */
function printWebConsoleInfo() {
  const config = getZylosConfig();

  const envPath = path.join(ZYLOS_DIR, '.env');
  let password = '';
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    // Read new name first, fall back to legacy
    const matchNew = content.match(/^ZYLOS_WEB_PASSWORD=(.+)/m);
    const matchOld = content.match(/^WEB_CONSOLE_PASSWORD=(.+)/m);
    if (matchNew) password = matchNew[1].trim();
    else if (matchOld) password = matchOld[1].trim();
  } catch { /* */ }

  if (!password) return;

  const line = cyan('  ════════════════════════════════════════════════════');

  console.log('');
  console.log(line);
  console.log('');
  console.log(`  ${bold('  Web Console')}`);
  console.log('');

  if (config.domain) {
    const proto = config.protocol || 'https';
    const url = `${proto}://${config.domain}/console/`;
    console.log(`    URL:      ${bold(url)}`);
  } else {
    const port = process.env.WEB_CONSOLE_PORT || '3456';
    console.log(`    Local:    ${bold(`http://localhost:${port}/console/`)}`);
    const ip = getNetworkIP();
    if (ip) {
      console.log(`    Network:  ${bold(`http://${ip}:${port}/console/`)}`);
    }
  }

  console.log(`    Password: ${bgGreen(bold(` ${password} `))}`);
  console.log('');
  console.log(`    ${dim(`Save this password — also in ${ZYLOS_DIR}/.env`)}`);
  console.log('');
  console.log(line);
}

// ── Database initialization ─────────────────────────────────────

/**
 * Initialize databases for skills that require them.
 */
function initializeDatabases() {
  const dbInitScript = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-db.js');
  const dbInitSql = path.join(SKILLS_DIR, 'comm-bridge', 'init-db.sql');
  if (!fs.existsSync(dbInitSql) || !fs.existsSync(dbInitScript)) return;

  try {
    execSync(`node "${dbInitScript}" init`, {
      cwd: path.join(SKILLS_DIR, 'comm-bridge'),
      stdio: 'pipe',
      timeout: 10000,
    });
    console.log(`  ${success('Database initialized')}`);
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
    console.log(`  ${warn(`Database init failed: ${msg}`)}`);
  }
}

// ── Service startup ─────────────────────────────────────────────

/**
 * Prepare and start core services via PM2 ecosystem config.
 * @returns {number} Number of services successfully started
 */
function startCoreServices(webPassword = null) {
  installSkillDependencies();
  ensureWebConsolePassword(webPassword);
  initializeDatabases();

  const ecosystemPath = path.join(ZYLOS_DIR, 'pm2', 'ecosystem.config.cjs');
  if (!fs.existsSync(ecosystemPath)) {
    console.log(`  ${warn('ecosystem.config.cjs not found')}`);
    return 0;
  }

  try {
    // Delete existing core services first so PM2 fully re-evaluates ecosystem config
    // (--update-env does NOT re-execute the JS, so env changes like SYSTEM_PATH won't apply)
    const serviceNames = getCoreServiceNames();
    for (const name of serviceNames) {
      try { execSync(`pm2 delete "${name}"`, { stdio: 'pipe' }); } catch {}
    }
    execSync(`pm2 start "${ecosystemPath}"`, { stdio: 'pipe', timeout: 30000 });
    execSync('pm2 save', { stdio: 'pipe' });
  } catch (err) {
    console.log(`  ${warn(`Failed to start services: ${err.message}`)}`);
    return 0;
  }

  // Report status of core services only
  try {
    const serviceNames = getCoreServiceNames();
    const list = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const procs = JSON.parse(list);
    let started = 0;
    for (const proc of procs) {
      if (!serviceNames.includes(proc.name)) continue;
      if (proc.pm2_env?.status === 'online') {
        console.log(`  ${success(bold(proc.name))}`);
        started++;
      } else {
        console.log(`  ${error(`${bold(proc.name)}: ${proc.pm2_env?.status || 'unknown'}`)}`);
      }
    }
    return started;
  } catch {
    return 0;
  }
}

// ── PM2 boot auto-start ──────────────────────────────────────────

/**
 * Configure PM2 to auto-start on system boot.
 * Runs `pm2 startup` which generates a systemd service command,
 * then executes it. Idempotent — safe to run multiple times.
 */
function setupPm2Startup() {
  // pm2 startup exits non-zero when it needs a sudo command to be run,
  // so we use spawnSync to always capture output regardless of exit code.
  const result = spawnSync('pm2', ['startup'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 15000,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

  // Extract the sudo command from output
  // Typical: "sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u howard --hp /home/howard"
  const sudoMatch = output.match(/^(sudo .+)$/m);
  if (sudoMatch) {
    try {
      execSync(sudoMatch[1], { stdio: 'pipe', timeout: 30000 });
      console.log(`  ${success('PM2 boot auto-start configured')}`);
      return;
    } catch (err) {
      const msg = (err.stderr || '').toString().trim().split('\n')[0] || err.message;
      console.log(`  ${warn(`PM2 boot auto-start: sudo command failed: ${msg}`)}`);
      console.log(`    ${dim(`Fix manually: ${sudoMatch[1]}`)}`);
      return;
    }
  }

  // No sudo command found — may already be configured or failed
  if (result.status === 0) {
    console.log(`  ${success('PM2 boot auto-start configured')}`);
  } else {
    const msg = output.trim().split('\n')[0] || 'unknown error';
    console.log(`  ${warn(`PM2 boot auto-start setup failed: ${msg}`)}`);
    console.log(`    ${dim('Fix manually: pm2 startup (then run the sudo command it outputs)')}`);
  }
}

// ── Caddy web server setup ───────────────────────────────────────

/**
 * Detect system architecture for Caddy binary download.
 * @returns {{ os: string, arch: string }}
 */
function detectPlatform() {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' };
  const arch = archMap[process.arch] || 'amd64';
  return { os: platform, arch };
}

/**
 * Get the latest Caddy version from GitHub API.
 * Falls back to a known stable version on failure.
 * @returns {string} Version string without 'v' prefix (e.g. "2.10.2")
 */
function getLatestCaddyVersion() {
  const FALLBACK_VERSION = '2.10.2';
  try {
    const output = execSync(
      'curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
    );
    const data = JSON.parse(output);
    return (data.tag_name || '').replace(/^v/, '') || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/**
 * Download Caddy binary to ~/zylos/bin/caddy.
 * @returns {boolean} true if download succeeded
 */
function downloadCaddy() {
  if (fs.existsSync(CADDY_BIN)) {
    console.log(`  ${success('Caddy binary already installed')}`);
    return true;
  }

  const { os: platform, arch } = detectPlatform();
  console.log(`  ${dim(`Detecting platform: ${platform}/${arch}`)}`);

  const version = getLatestCaddyVersion();
  console.log(`  ${dim(`Latest Caddy version: v${version}`)}`);

  const filename = `caddy_${version}_${platform}_${arch}.tar.gz`;
  const url = `https://github.com/caddyserver/caddy/releases/download/v${version}/${filename}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-caddy-'));
  const tarballPath = path.join(tmpDir, filename);

  try {
    console.log(`  ${cyan('Downloading Caddy...')}`);
    execSync(`curl -fsSL -o "${tarballPath}" "${url}"`, {
      stdio: 'pipe',
      timeout: 120000,
    });

    // Extract just the caddy binary
    execSync(`tar xzf "${tarballPath}" -C "${tmpDir}" caddy`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    // Move to bin directory
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.copyFileSync(path.join(tmpDir, 'caddy'), CADDY_BIN);
    fs.chmodSync(CADDY_BIN, 0o755);

    console.log(`  ${success(`Caddy v${version} installed to ~/zylos/bin/caddy`)}`);
    return true;
  } catch (err) {
    console.log(`  ${warn(`Failed to download Caddy: ${err.message}`)}`);
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Set CAP_NET_BIND_SERVICE on Caddy binary so it can bind to ports 80/443
 * without running as root. Requires one-time sudo.
 * @returns {boolean} true if setcap succeeded
 */
function setCaddyCapabilities() {
  if (process.platform === 'darwin') return true; // macOS doesn't need this
  if (process.getuid?.() === 0) return true; // root already has all capabilities

  try {
    // Check if capability is already set
    const caps = execSync(`getcap "${CADDY_BIN}" 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (caps.includes('cap_net_bind_service')) {
      return true;
    }
  } catch { /* continue */ }

  try {
    execSync(`sudo setcap cap_net_bind_service=+ep "${CADDY_BIN}"`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    console.log(`  ${success('Port binding capability set (ports 80/443)')}`);
    return true;
  } catch {
    console.log(`  ${warn('Could not set port binding capability (sudo required)')}`);
    console.log(`    ${dim('Caddy may not be able to bind to ports 80/443.')}`);
    console.log(`    ${dim(`Fix manually: sudo setcap cap_net_bind_service=+ep "${CADDY_BIN}"`)}`);
    return false;
  }
}

/**
 * Generate a Caddyfile for the given domain and protocol.
 * @param {string} domain - The domain name
 * @param {string} [protocol='https'] - 'https' (bare domain, auto-cert) or 'http'
 */
function generateCaddyfile(domain, protocol = 'https') {
  const publicDir = path.join(HTTP_DIR, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  // Caddy syntax: bare domain = HTTPS + auto-cert, http:// prefix = HTTP only
  const siteAddress = protocol === 'http' ? `http://${domain}` : domain;

  const content = `# Zylos Caddyfile — managed by zylos-core
# Domain: ${domain}
# Protocol: ${protocol}

${siteAddress} {
    root * ${publicDir}

    file_server {
        hide .git .env *.db *.json
    }

    @markdown path *.md
    handle @markdown {
        header Content-Type "text/plain; charset=utf-8"
    }

    handle /health {
        respond "OK" 200
    }

    # Web Console (core built-in)
    redir /console /console/ permanent
    handle /console/* {
        uri strip_prefix /console
        reverse_proxy localhost:3456
    }

    log {
        output file ${HTTP_DIR}/caddy-access.log {
            roll_size 10mb
            roll_keep 3
        }
    }
}
`;

  fs.writeFileSync(CADDYFILE, content);
}

/**
 * Run the Caddy setup flow: download binary, prompt for domain,
 * generate Caddyfile, set capabilities.
 * @param {boolean} skipConfirm - Skip interactive prompts
 * @param {object} opts - Resolved CLI options
 * @returns {Promise<boolean>} true if Caddy was set up
 */
async function setupCaddy(skipConfirm, opts = {}) {
  // --no-caddy: skip entirely
  if (opts.caddy === false) {
    console.log(`  ${dim('Caddy setup skipped (--no-caddy).')}`);
    return true; // not a failure, just skipped
  }

  // Check if already fully set up (and no override flags)
  if (fs.existsSync(CADDY_BIN) && fs.existsSync(CADDYFILE) && !opts.domain) {
    const config = getZylosConfig();
    if (config.domain) {
      const proto = config.protocol || 'https';
      console.log(`  ${success(`Caddy already configured (${bold(`${proto}://${config.domain}`)})`)}`);
      return true;
    }
  }

  // Ask user if they want Caddy (skip prompt if --caddy, domain, or -y)
  if (!skipConfirm && opts.caddy !== true && !opts.domain) {
    const wantCaddy = await promptYesNo('Set up Caddy web server? [Y/n]: ', true);
    if (!wantCaddy) {
      console.log(`  ${dim('Skipping Caddy setup. Run "zylos init" later to set up.')}`);
      return false;
    }
  }

  // Resolve domain: CLI/env > existing config > interactive prompt
  const config = getZylosConfig();
  let domain = opts.domain || config.domain || '';
  if (!domain || domain === 'your.domain.com') {
    if (!skipConfirm) {
      domain = await prompt('Enter your domain (e.g., zylos.example.com): ');
    }
    if (!domain) {
      if (opts.caddy === true) {
        // --caddy without domain: install binary but skip Caddyfile
        console.log(`  ${dim('No domain provided. Installing Caddy binary only.')}`);
        if (!downloadCaddy()) return false;
        setCaddyCapabilities();
        return true;
      }
      console.log(`  ${warn('No domain provided. Skipping Caddy setup.')}`);
      return false;
    }
  }

  // Resolve protocol: CLI/env > existing config > prompt > default
  let protocol;
  if (opts.https === true) protocol = 'https';
  else if (opts.https === false) protocol = 'http';
  else protocol = config.protocol || '';

  if (!protocol && !skipConfirm) {
    const useHttps = await promptYesNo('Use HTTPS with auto-certificate? [Y/n]: ', true);
    protocol = useHttps ? 'https' : 'http';
  }
  if (!protocol) protocol = 'https';

  // Save domain and protocol to config.json
  updateZylosConfig({ domain, protocol });
  console.log(`  ${dim('Domain:')} ${bold(domain)}`);
  console.log(`  ${dim('Protocol:')} ${bold(protocol)}`);

  // Download Caddy binary
  if (!downloadCaddy()) return false;

  // Set capabilities for port binding
  setCaddyCapabilities();

  // Generate Caddyfile
  fs.mkdirSync(HTTP_DIR, { recursive: true });
  generateCaddyfile(domain, protocol);
  console.log(`  ${success('Caddyfile generated at ~/zylos/http/Caddyfile')}`);

  return true;
}

// ── CLI flag parsing & validation ────────────────────────────────

/**
 * Parse CLI flags for `zylos init`.
 * Supports long flags, short flags, and combined short flags (e.g., -yq).
 *
 * @param {string[]} args - CLI arguments (after command name)
 * @returns {object} Parsed options
 */
function parseInitFlags(args) {
  const opts = {
    yes: false,
    quiet: false,
    help: false,
    timezone: null,
    setupToken: null,
    apiKey: null,
    domain: null,
    https: null,   // null = not specified, true = --https, false = --no-https
    caddy: null,   // null = not specified, true = --caddy, false = --no-caddy
    webPassword: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Combined short flags (e.g., -yq → -y + -q)
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2) {
      for (const ch of arg.slice(1)) {
        if (ch === 'y') opts.yes = true;
        else if (ch === 'q') opts.quiet = true;
        else if (ch === 'h') opts.help = true;
      }
      continue;
    }

    switch (arg) {
      case '--yes': case '-y': opts.yes = true; break;
      case '--quiet': case '-q': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--timezone':
      case '--setup-token':
      case '--api-key':
      case '--domain':
      case '--web-password': {
        const val = args[++i];
        if (!val || val.startsWith('-')) {
          console.error(`${error(`Error: ${arg} requires a value`)}`);
          process.exit(1);
        }
        if (arg === '--timezone') opts.timezone = val;
        else if (arg === '--setup-token') opts.setupToken = val;
        else if (arg === '--api-key') opts.apiKey = val;
        else if (arg === '--domain') opts.domain = val;
        else if (arg === '--web-password') opts.webPassword = val;
        break;
      }
      case '--https': opts.https = true; break;
      case '--no-https': opts.https = false; break;
      case '--caddy': opts.caddy = true; break;
      case '--no-caddy': opts.caddy = false; break;
    }
  }

  return opts;
}

/**
 * Fill in options from environment variables where CLI flags were not provided.
 * Resolution: CLI flag > env var > existing config > interactive prompt.
 *
 * @param {object} opts - Parsed CLI options (mutated in place)
 */
function resolveFromEnv(opts) {
  // Only promote auth tokens from env when:
  // 1. Not already authenticated (avoids redundant re-verification)
  // 2. No auth token was provided via CLI flag (avoids false mutual-exclusion
  //    errors when e.g. --setup-token is on CLI but ANTHROPIC_API_KEY is in env)
  const alreadyAuthed = commandExists('claude') && isClaudeAuthenticated();
  const hasCliAuth = opts.setupToken !== null || opts.apiKey !== null;
  if (!alreadyAuthed && !hasCliAuth) {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      opts.setupToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      opts.apiKey = process.env.ANTHROPIC_API_KEY;
    }
  }
  if (opts.domain === null && process.env.ZYLOS_DOMAIN) {
    opts.domain = process.env.ZYLOS_DOMAIN;
  }
  if (opts.https === null && process.env.ZYLOS_PROTOCOL) {
    opts.https = process.env.ZYLOS_PROTOCOL === 'https';
  }
  if (opts.webPassword === null) {
    opts.webPassword = process.env.ZYLOS_WEB_PASSWORD || process.env.WEB_CONSOLE_PASSWORD || null;
  }
  // TZ: do NOT pick up ambient TZ from the environment.
  // Docker containers often have TZ=UTC set by default, which would silently
  // overwrite user-configured timezones on re-init. Only --timezone flag applies.
  // The auto-detect in configureTimezone() will handle the default case.
}

/**
 * Validate resolved options. Returns error message or null if valid.
 *
 * @param {object} opts - Resolved options
 * @returns {string|null} Error message or null
 */
function validateInitOptions(opts) {
  // Mutual exclusion: setup-token and api-key
  if (opts.setupToken && opts.apiKey) {
    return '--setup-token and --api-key are mutually exclusive.\n  Run zylos init and choose one during setup.';
  }

  // Setup token format
  if (opts.setupToken && !opts.setupToken.startsWith('sk-ant-oat')) {
    return 'Invalid setup token. It should start with "sk-ant-oat".\n  Generate one with: claude setup-token\n  Then run: zylos init --setup-token <token>';
  }

  // API key format (reject setup tokens — they start with sk-ant-oat)
  if (opts.apiKey && !opts.apiKey.startsWith('sk-ant-')) {
    return 'Invalid API key. It should start with "sk-ant-".\n  Get your key at: https://console.anthropic.com/settings/keys\n  Then run: zylos init --api-key <key>';
  }
  if (opts.apiKey && opts.apiKey.startsWith('sk-ant-oat')) {
    return 'That looks like a setup token, not an API key.\n  Use --setup-token instead: zylos init --setup-token <token>';
  }

  // Timezone validation
  if (opts.timezone && !isValidTimezone(opts.timezone)) {
    return `Invalid timezone: "${opts.timezone}".\n  Run: zylos init --timezone Asia/Shanghai`;
  }

  // Domain validation (basic hostname check)
  if (opts.domain) {
    const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
    if (!domainPattern.test(opts.domain)) {
      return `Invalid domain: "${opts.domain}".\n  Run: zylos init --domain agent.example.com`;
    }
  }

  // Protocol validation (via ZYLOS_PROTOCOL env var — already resolved to boolean,
  // but validate the raw env var if it was the source)
  if (process.env.ZYLOS_PROTOCOL && !['https', 'http'].includes(process.env.ZYLOS_PROTOCOL)) {
    return `Invalid ZYLOS_PROTOCOL: "${process.env.ZYLOS_PROTOCOL}". Must be "https" or "http".`;
  }

  return null;
}

/**
 * Print help text for `zylos init`.
 */
function printInitHelp() {
  console.log(`
Usage: zylos init [options]

Options:
  -y, --yes                  Non-interactive mode (skip all prompts, use defaults)
  -q, --quiet                Minimal output (for CI/CD)
  --timezone <tz>            Set timezone (IANA format, e.g., Asia/Shanghai)
  --setup-token <token>      Authenticate with Claude setup token
  --api-key <key>            Authenticate with Anthropic API key
  --domain <domain>          Configure Caddy with this domain
  --https / --no-https       Enable/disable HTTPS (default: https when domain set)
  --caddy / --no-caddy       Install/skip Caddy web server (default: install)
  --web-password <password>  Set web console password (default: auto-generate)

Environment variables:
  CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ZYLOS_DOMAIN,
  ZYLOS_PROTOCOL, ZYLOS_WEB_PASSWORD

  Resolution: CLI flag > env var > .env/config.json > interactive prompt

Note: --setup-token and --api-key values are visible in process listings.
  On shared systems, prefer environment variables instead:
    CLAUDE_CODE_OAUTH_TOKEN=... zylos init -y
`);
}

// ── Main init command ───────────────────────────────────────────

export async function initCommand(args) {
  const opts = parseInitFlags(args);

  // --help: print usage and exit
  if (opts.help) {
    printInitHelp();
    return;
  }

  // Resolve from environment variables
  resolveFromEnv(opts);

  // Validate options
  const validationErr = validateInitOptions(opts);
  if (validationErr) {
    console.error(`${error(`Error: ${validationErr}`)}`);
    process.exit(1);
  }

  const skipConfirm = opts.yes;
  const quiet = opts.quiet;

  // Track exit code: 0 = success, 1 = fatal, 2 = partial success
  let exitCode = 0;

  // Root sandbox — Claude Code refuses --dangerously-skip-permissions as root
  // unless IS_SANDBOX=1 is set. Auto-set it so root users (e.g. Docker) just work.
  if (process.getuid?.() === 0 && !process.env.IS_SANDBOX) {
    process.env.IS_SANDBOX = '1';
  }

  if (!quiet) {
    console.log(`\n${heading('Welcome to Zylos!')} Let's set up your AI assistant.\n`);
  }

  // Step 1: Check prerequisites (always, even on re-init)
  if (!quiet) console.log(heading('Checking prerequisites...'));

  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    console.error(`  ${error(`Node.js ${nodeCheck.version} (requires ${nodeCheck.required})`)}`);
    console.error(`    ${dim('Please upgrade Node.js and try again.')}`);
    process.exit(1);
  }
  if (!quiet) console.log(`  ${success(`Node.js ${nodeCheck.version}`)}`);

  // Step 2: Check/install tmux
  if (commandExists('tmux')) {
    if (!quiet) console.log(`  ${success('tmux installed')}`);
  } else {
    if (!quiet) console.log(`  ${error('tmux not found')}`);
    if (!quiet) console.log(`    ${cyan('Installing tmux...')}`);
    if (installSystemPackage('tmux')) {
      if (!quiet) console.log(`  ${success('tmux installed')}`);
    } else {
      console.error(`  ${error('Failed to install tmux')}`);
      console.error(`    ${dim('Install manually: brew install tmux (macOS) / apt install tmux (Linux)')}`);
      process.exit(1);
    }
  }

  // Step 3: Check/install git
  if (commandExists('git')) {
    if (!quiet) console.log(`  ${success('git installed')}`);
  } else {
    if (!quiet) console.log(`  ${error('git not found')}`);
    if (!quiet) console.log(`    ${cyan('Installing git...')}`);
    if (installSystemPackage('git')) {
      if (!quiet) console.log(`  ${success('git installed')}`);
    } else {
      console.error(`  ${error('Failed to install git')}`);
      console.error(`    ${dim('Install manually: brew install git (macOS) / apt install git (Linux)')}`);
      process.exit(1);
    }
  }

  // Step 4: Check/install PM2
  if (commandExists('pm2')) {
    if (!quiet) console.log(`  ${success('PM2 installed')}`);
  } else {
    if (!quiet) console.log(`  ${error('PM2 not found')}`);
    if (!quiet) console.log(`    ${cyan('Installing pm2...')}`);
    if (installGlobalPackage('pm2')) {
      if (!quiet) console.log(`  ${success('PM2 installed')}`);
    } else {
      console.error(`  ${error('Failed to install PM2')}`);
      console.error(`    ${dim('Install manually: npm install -g pm2')}`);
      process.exit(1);
    }
  }

  // Step 5: Check/install Claude Code (native installer)
  let claudeJustInstalled = false;
  if (commandExists('claude')) {
    if (!quiet) console.log(`  ${success('Claude Code installed')}`);
  } else {
    if (!quiet) console.log(`  ${error('Claude Code not found')}`);
    if (!quiet) console.log(`    ${cyan('Installing Claude Code (native installer)...')}`);
    try {
      execSync('curl -fsSL https://claude.ai/install.sh | bash', {
        stdio: 'pipe',
        timeout: 300000, // 5 min — downloads ~213MB native binary
      });
      if (commandExists('claude')) {
        if (!quiet) console.log(`  ${success('Claude Code installed')}`);
        claudeJustInstalled = true;
      } else {
        console.error(`  ${error('Claude Code installed but not found in PATH')}`);
        console.error(`    ${dim('Add ~/.local/bin to your PATH, then run zylos init again.')}`);
        process.exit(1);
      }
    } catch {
      console.error(`  ${error('Failed to install Claude Code')}`);
      console.error(`    ${dim('Install manually: curl -fsSL https://claude.ai/install.sh | bash')}`);
      process.exit(1);
    }
  }

  // Step 6: Claude auth check + guided login
  let claudeAuthenticated = false;
  let pendingApiKey = null; // set if user enters API key, written to .env after templates
  let pendingSetupToken = null; // set if user enters setup-token, written to .env after templates
  if (commandExists('claude')) {
    claudeAuthenticated = isClaudeAuthenticated();
    if (claudeAuthenticated) {
      if (!quiet) console.log(`  ${success('Claude Code authenticated')}`);
    } else if (opts.setupToken) {
      // Setup token provided via flag/env — save, verify via actual API call, rollback on failure
      if (saveSetupToken(opts.setupToken)) {
        if (!quiet) console.log(`  ${dim('Verifying setup token...')}`);
        const tokenResult = verifySetupToken();
        if (tokenResult.valid) {
          pendingSetupToken = opts.setupToken;
          claudeAuthenticated = true;
          if (!quiet) console.log(`  ${success('Setup token verified and saved')}`);
        } else {
          rollbackSetupToken();
          if (tokenResult.authError) {
            console.error(`  ${error('Setup token is invalid or expired.')}`);
            console.error(`    ${dim('Generate a new one: claude setup-token')}`);
          } else {
            console.error(`  ${error('Could not verify setup token. Check network and try again.')}`);
            if (tokenResult.message) console.error(`    ${dim(tokenResult.message.split('\n')[0])}`);
          }
          if (skipConfirm) exitCode = 1;
        }
      }
    } else if (opts.apiKey) {
      // API key provided via flag/env — verify and use directly (already validated format)
      if (!quiet) console.log(`  ${dim('Verifying API key...')}`);
      const keyValid = await verifyApiKey(opts.apiKey);
      if (!keyValid) {
        console.error(`  ${error('API key is invalid or could not be verified.')}`);
        console.error(`    ${dim('Check your key at console.anthropic.com')}`);
        if (skipConfirm) exitCode = 1;
      } else if (saveApiKey(opts.apiKey)) {
        pendingApiKey = opts.apiKey;
        claudeAuthenticated = true;
        if (!quiet) console.log(`  ${success('API key verified and saved')}`);
      }
    } else {
      if (!quiet) console.log(`  ${warn('Claude Code not authenticated')}`);
      if (!skipConfirm) {
        const authChoice = await promptChoice(
          '\n  How would you like to authenticate?',
          ['Claude subscription (opens browser login)', 'Anthropic API key', 'Setup token (from claude setup-token)'],
        );

        if (authChoice === 1) {
          // Option 1: Subscription login (existing flow)
          console.log(`\n  ${cyan('Starting Claude Code for authentication...')}`);
          console.log(`  ${dim('After login, type /exit to return to zylos init.')}\n`);
          const sigintListeners = process.rawListeners('SIGINT');
          process.removeAllListeners('SIGINT');
          process.on('SIGINT', () => {});
          try {
            const authChild = spawn('claude', [], { stdio: 'inherit' });
            await new Promise((resolve) => authChild.on('close', resolve));
          } catch { /* user may Ctrl+C */ }
          process.removeAllListeners('SIGINT');
          for (const l of sigintListeners) process.on('SIGINT', l);
          claudeAuthenticated = isClaudeAuthenticated();
          if (claudeAuthenticated) {
            console.log(`\n  ${success('Claude Code authenticated')}`);
          } else {
            console.log(`\n  ${warn('Authentication not completed.')}`);
            console.log(`    ${dim('Run "claude" to authenticate then "zylos init" again.')}`);
          }
        } else if (authChoice === 2) {
          // Option 2: API key
          console.log(`\n  ${dim('Paste your Anthropic API key (starts with sk-ant-):')}`);
          const apiKey = await promptSecret('  API key: ');
          if (!apiKey) {
            console.log(`  ${warn('No key entered. Skipped.')}`);
          } else if (!apiKey.startsWith('sk-ant-')) {
            console.log(`  ${error('Invalid format. API key should start with sk-ant-')}`);
            console.log(`    ${dim('You can set it later: export ANTHROPIC_API_KEY=sk-ant-xxx')}`);
          } else {
            console.log(`  ${dim('Verifying API key...')}`);
            const keyValid = await verifyApiKey(apiKey);
            if (!keyValid) {
              console.log(`  ${error('API key is invalid or could not be verified.')}`);
              console.log(`    ${dim('Check your key at console.anthropic.com')}`);
            } else if (saveApiKey(apiKey)) {
              pendingApiKey = apiKey;
              claudeAuthenticated = true;
              console.log(`  ${success('API key verified and saved')}`);
            }
          }
        } else if (authChoice === 3) {
          // Option 3: Setup token (OAuth token from claude setup-token)
          console.log(`\n  ${dim('Paste your setup token (starts with sk-ant-oat):')}`);
          console.log(`  ${dim('Generate one by running "claude setup-token" on a machine with a browser.')}`);
          const token = await promptSecret('  Setup token: ');
          if (!token) {
            console.log(`  ${warn('No token entered. Skipped.')}`);
          } else if (!token.startsWith('sk-ant-oat')) {
            console.log(`  ${error('Invalid format. Setup token should start with sk-ant-oat')}`);
            console.log(`    ${dim('Run "claude setup-token" to generate a valid token.')}`);
          } else if (saveSetupToken(token)) {
            console.log(`  ${dim('Verifying setup token...')}`);
            const tokenResult = verifySetupToken();
            if (tokenResult.valid) {
              pendingSetupToken = token;
              claudeAuthenticated = true;
              console.log(`  ${success('Setup token verified and saved')}`);
            } else {
              rollbackSetupToken();
              if (tokenResult.authError) {
                console.log(`  ${error('Setup token is invalid or expired.')}`);
                console.log(`    ${dim('Generate a new one: claude setup-token')}`);
              } else {
                console.log(`  ${error('Could not verify setup token. Check network and try again.')}`);
                if (tokenResult.message) console.log(`    ${dim(tokenResult.message.split('\n')[0])}`);
              }
            }
          }
        }
      } else {
        if (!quiet) console.log(`    ${dim('Run "zylos init" again to authenticate.')}`);
      }
    }
  }

  // Pre-accept Claude Code terms (skips manual prompts on first launch)
  if (claudeAuthenticated) {
    if (preAcceptClaudeTerms()) {
      if (!quiet) console.log(`  ${success('Claude Code terms pre-accepted')}`);
    }
  }

  if (!quiet) console.log('');

  // Re-init: skip directory creation, just sync + deploy + start
  const installState = detectInstallState();

  if (installState === 'complete') {
    if (!quiet) console.log(`${dim('Zylos is already initialized at')} ${bold(ZYLOS_DIR)}\n`);

    // Ensure bin directory and PATH are configured (idempotent)
    fs.mkdirSync(BIN_DIR, { recursive: true });
    if (ensureBinInPath()) {
      if (!quiet) console.log(success('Added ~/zylos/bin to PATH'));
    }

    const syncResult = syncCoreSkills();
    if (!quiet) {
      if (syncResult.updated.length > 0) {
        console.log(`${success('Core Skills updated:')} ${syncResult.updated.join(', ')}`);
      }
      if (syncResult.installed.length > 0) {
        console.log(`${success('Core Skills installed:')} ${syncResult.installed.join(', ')}`);
      }
    }

    if (!quiet) console.log(heading('Deploying templates...'));
    deployTemplates();

    // Migrate WEB_CONSOLE_PASSWORD → ZYLOS_WEB_PASSWORD
    migrateWebConsolePassword();

    // Write auth credentials to .env if entered during this run
    if (pendingApiKey) {
      saveApiKeyToEnv(pendingApiKey);
    }
    if (pendingSetupToken) {
      saveSetupTokenToEnv(pendingSetupToken);
    }

    // Timezone: use resolved value or show current
    if (!quiet) console.log(heading('Checking timezone...'));
    await configureTimezone(skipConfirm, true, opts.timezone, quiet);

    // Caddy setup (idempotent — skips if already configured)
    if (!quiet) console.log(heading('Checking Caddy...'));
    const caddyOk = await setupCaddy(skipConfirm, opts);
    if (!caddyOk && opts.caddy !== false && opts.domain) {
      exitCode = 2; // optional step failed
    }

    if (!quiet) console.log(heading('Starting services...'));
    const servicesStarted = startCoreServices(opts.webPassword);
    if (servicesStarted > 0) {
      setupPm2Startup();
      if (!quiet) console.log(`\n${green(`${servicesStarted} service(s) started.`)} ${dim('Run "zylos status" to check.')}`);
    } else {
      if (!quiet) console.log(`\n${dim('No services to start.')}`);
    }

    if (claudeAuthenticated && !skipConfirm && needsBypassAcceptance()) {
      await guideBypassAcceptance();
    }

    if (!claudeAuthenticated) {
      if (!quiet) {
        console.log(`\n${warn('Claude Code is not authenticated.')}`);
        console.log(`  ${dim('Run "zylos init" again to authenticate.')}`);
      }
    }
    printWebConsoleInfo();
    if (!quiet) console.log(`\n${dim('Use "zylos add <component>" to add components.')}`);
    if (exitCode) process.exit(exitCode);
    return;
  }

  if (installState === 'incomplete') {
    if (!quiet) console.log(`${warn('Incomplete installation detected at')} ${bold(ZYLOS_DIR)}`);
    if (!skipConfirm) {
      const answer = await prompt('Continue previous installation or start fresh? [c/f] (c): ');
      if (answer.toLowerCase() === 'f') {
        if (!quiet) console.log('Resetting managed state...');
        resetManagedState();
        if (!quiet) console.log('Starting fresh...\n');
      } else {
        if (!quiet) console.log('Continuing...\n');
      }
    }
  }

  // Step 6: Create directory structure
  if (!quiet) {
    console.log(`${dim('Install directory:')} ${bold(ZYLOS_DIR)}`);
    console.log(`\n${heading('Setting up...')}`);
  }
  createDirectoryStructure();
  if (!quiet) console.log(`  ${success('Created directory structure')}`);

  // Configure PATH for ~/zylos/bin
  if (ensureBinInPath()) {
    if (!quiet) console.log(`  ${success('Added ~/zylos/bin to PATH')}`);
  }

  // Step 7: Deploy templates
  deployTemplates();
  if (!quiet) console.log(`  ${success('Templates deployed')}`);

  // Migrate WEB_CONSOLE_PASSWORD → ZYLOS_WEB_PASSWORD
  migrateWebConsolePassword();

  // Write auth credentials to .env now that templates have been deployed
  if (pendingApiKey) {
    saveApiKeyToEnv(pendingApiKey);
  }
  if (pendingSetupToken) {
    saveSetupTokenToEnv(pendingSetupToken);
  }

  // Step 8: Configure timezone
  if (!quiet) console.log(`\n${heading('Timezone configuration...')}`);
  await configureTimezone(skipConfirm, false, opts.timezone, quiet);

  // Step 9: Sync Core Skills
  const syncResult = syncCoreSkills();
  if (!quiet) {
    if (syncResult.error) {
      console.log(`  ${warn(syncResult.error)}`);
    } else {
      const counts = [`${syncResult.installed.length} installed`, `${syncResult.updated.length} updated`];
      console.log(`  ${success(`Core Skills synced (${counts.join(', ')})`)}`);
      for (const name of syncResult.installed) {
        console.log(`    ${green('+')} ${bold(name)}`);
      }
    }
  }

  // Step 10: Caddy web server setup
  if (!quiet) console.log(`\n${heading('HTTPS setup...')}`);
  const caddyOk = await setupCaddy(skipConfirm, opts);
  if (!caddyOk && opts.caddy !== false && opts.domain) {
    exitCode = 2; // optional step failed
  }

  // Step 11: Start services
  let servicesStarted = 0;
  if (!skipConfirm) {
    const startNow = await promptYesNo('\nStart services now? [Y/n]: ', true);
    if (startNow) {
      if (!quiet) console.log(`\n${heading('Starting services...')}`);
      servicesStarted = startCoreServices(opts.webPassword);
    }
  } else {
    if (!quiet) console.log(`\n${heading('Starting services...')}`);
    servicesStarted = startCoreServices(opts.webPassword);
  }

  if (servicesStarted > 0) {
    setupPm2Startup();
  }

  // First-time Claude bypass acceptance (only if authenticated, skip in non-interactive mode)
  if (claudeAuthenticated && !skipConfirm && needsBypassAcceptance()) {
    await guideBypassAcceptance();
  }

  // Done
  if (!quiet) {
    console.log(`\n${success(bold('Zylos initialized successfully!'))}\n`);
  }

  if (servicesStarted > 0 && !quiet) {
    console.log(`${green(`${servicesStarted} service(s) started.`)} ${dim('Run "zylos status" to check.')}\n`);
  }

  printWebConsoleInfo();

  if (claudeJustInstalled) {
    // Auto-add ~/.local/bin to shell profile so future shell sessions find claude
    ensureLocalBinInProfile();
  }

  if (!quiet) {
    console.log(`\n${heading('Next steps:')}`);
    if (!claudeAuthenticated) {
      console.log(`  ${bold('zylos init')}                        ${dim('# ⚠ Authenticate first')}`);
    }
    console.log(`  ${bold('zylos add telegram')}    ${dim('# Add Telegram bot')}`);
    console.log(`  ${bold('zylos add lark')}        ${dim('# Add Lark bot')}`);
    console.log(`  ${bold('zylos status')}          ${dim('# Check service status')}`);
    console.log('');
  }

  if (exitCode) process.exit(exitCode);
}
