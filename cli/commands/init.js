/**
 * zylos init - Initialize Zylos environment
 *
 * Sets up the directory structure, checks prerequisites,
 * syncs Core Skills, deploys templates, and starts services.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { ZYLOS_DIR, SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, COMPONENTS_FILE, BIN_DIR, HTTP_DIR, CADDYFILE, CADDY_BIN, getZylosConfig, updateZylosConfig } from '../lib/config.js';
import { generateManifest, saveManifest } from '../lib/manifest.js';
import { prompt, promptYesNo } from '../lib/prompts.js';

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

function commandExists(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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
  const cmds = platform === 'darwin'
    ? [`brew install ${pkg}`]
    : [`sudo apt-get install -y ${pkg}`, `sudo yum install -y ${pkg}`];

  for (const cmd of cmds) {
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 120000 });
      return true;
    } catch {
      // Try next
    }
  }
  return false;
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
 */
async function configureTimezone(skipConfirm, isReinit) {
  const currentTz = readEnvTimezone();

  // Re-init with valid non-default timezone: just display it
  if (isReinit && currentTz && isValidTimezone(currentTz)) {
    console.log(`  ✓ Timezone: ${currentTz}`);
    return;
  }

  // Non-interactive mode: use detected timezone
  if (skipConfirm) {
    const detected = detectSystemTimezone();
    writeEnvTimezone(detected);
    console.log(`  ✓ Timezone: ${detected}`);
    return;
  }

  const detected = detectSystemTimezone();
  const useDetected = await promptYesNo(`  Detected timezone: ${detected}. Is this correct? [Y/n]: `, true);

  if (useDetected) {
    writeEnvTimezone(detected);
    console.log(`  ✓ Timezone: ${detected}`);
    return;
  }

  // Show common timezone list
  console.log('\n  Select timezone:');
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
      console.log(`  ✓ Timezone: ${tz}`);
      return;
    }

    if (num === COMMON_TIMEZONES.length + 1) {
      while (true) {
        const manual = await prompt('  Enter IANA timezone (e.g., America/Denver): ');
        if (!manual) continue;
        if (isValidTimezone(manual)) {
          writeEnvTimezone(manual);
          console.log(`  ✓ Timezone: ${manual}`);
          return;
        }
        console.log(`  ✗ Invalid timezone: "${manual}". Try again.`);
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
 * Check if Claude bypass permissions needs first-time acceptance.
 * Returns true if bypass is enabled and hasn't been accepted yet.
 */
function needsBypassAcceptance() {
  // Check if bypass is enabled in .env
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^CLAUDE_BYPASS_PERMISSIONS=(.+)$/m);
    if (match && match[1].trim() === 'false') return false;
  } catch {}

  // Check if already accepted (tmux session with Claude running)
  try {
    execSync('tmux has-session -t claude-main 2>/dev/null', { stdio: 'pipe' });
    // Session exists — check if Claude is actually running (not stuck on prompt)
    const paneContent = execSync('tmux capture-pane -t claude-main -p 2>/dev/null', { encoding: 'utf8' });
    if (paneContent.includes('>') || paneContent.includes('Claude')) {
      return false; // Claude is running, already accepted
    }
  } catch {}

  return true;
}

/**
 * Guide user through first-time Claude bypass permissions acceptance.
 */
async function guideBypassAcceptance() {
  console.log('\nSetting up Claude Code...');

  // Stop activity-monitor to prevent restart loop
  try { execSync('pm2 stop activity-monitor', { stdio: 'pipe' }); } catch {}

  // Kill existing session if stuck
  try { execSync('tmux kill-session -t claude-main 2>/dev/null', { stdio: 'pipe' }); } catch {}

  // Create new tmux session with Claude
  try {
    execSync(`tmux new-session -d -s claude-main "cd ${ZYLOS_DIR} && claude --dangerously-skip-permissions"`, { stdio: 'pipe' });
  } catch (err) {
    console.log(`  ⚠ Failed to create tmux session: ${err.message}`);
    try { execSync('pm2 start activity-monitor', { stdio: 'pipe' }); } catch {}
    return;
  }

  console.log('  Claude Code requires a one-time confirmation for autonomous mode.');
  console.log('  Please run the following command in another terminal:\n');
  console.log('    tmux attach -t claude-main\n');
  console.log('  Then select "Yes, I accept" and press Ctrl+B D to detach.\n');

  await promptYesNo('Press Enter after you have accepted the prompt: ', true);

  // Restart activity-monitor
  try { execSync('pm2 start activity-monitor', { stdio: 'pipe' }); } catch {}
  console.log('  ✓ Claude Code configured');
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
    console.log('  ✓ Created .env from template');
  }

  // Always save current shell PATH to .env (for PM2 services)
  saveSystemPath(envDest);

  // CLAUDE.md — only create if missing
  const claudeMdSrc = path.join(TEMPLATES_SRC, 'CLAUDE.md');
  const claudeMdDest = path.join(ZYLOS_DIR, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc) && !fs.existsSync(claudeMdDest)) {
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
    console.log('  ✓ Created CLAUDE.md from template');
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
      console.log(`  Warning: Failed to sync ${entry.name}`);
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

      console.log(`  Installing ${entry.name} dependencies...`);
      execSync('npm install --production', {
        cwd: skillDir,
        stdio: 'pipe',
        timeout: 120000,
      });
    } catch {
      console.log(`  ⚠ Failed to install ${entry.name} dependencies`);
    }
  }
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
    console.log('  ✓ Database initialized');
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
    console.log(`  ⚠ Database init failed: ${msg}`);
  }
}

// ── Service startup ─────────────────────────────────────────────

/**
 * Prepare and start core services via PM2 ecosystem config.
 * @returns {number} Number of services successfully started
 */
function startCoreServices() {
  installSkillDependencies();
  initializeDatabases();

  const ecosystemPath = path.join(ZYLOS_DIR, 'pm2', 'ecosystem.config.cjs');
  if (!fs.existsSync(ecosystemPath)) {
    console.log('  ⚠ ecosystem.config.cjs not found');
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
    console.log(`  ⚠ Failed to start services: ${err.message}`);
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
        console.log(`  ✓ ${proc.name}`);
        started++;
      } else {
        console.log(`  ✗ ${proc.name}: ${proc.pm2_env?.status || 'unknown'}`);
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
      console.log('  ✓ PM2 boot auto-start configured');
      return;
    } catch (err) {
      const msg = (err.stderr || '').toString().trim().split('\n')[0] || err.message;
      console.log(`  ⚠ PM2 boot auto-start: sudo command failed: ${msg}`);
      console.log(`    Fix manually: ${sudoMatch[1]}`);
      return;
    }
  }

  // No sudo command found — may already be configured or failed
  if (result.status === 0) {
    console.log('  ✓ PM2 boot auto-start configured');
  } else {
    const msg = output.trim().split('\n')[0] || 'unknown error';
    console.log(`  ⚠ PM2 boot auto-start setup failed: ${msg}`);
    console.log('    Fix manually: pm2 startup (then run the sudo command it outputs)');
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
    console.log('  ✓ Caddy binary already installed');
    return true;
  }

  const { os: platform, arch } = detectPlatform();
  console.log(`  Detecting platform: ${platform}/${arch}`);

  const version = getLatestCaddyVersion();
  console.log(`  Latest Caddy version: v${version}`);

  const filename = `caddy_${version}_${platform}_${arch}.tar.gz`;
  const url = `https://github.com/caddyserver/caddy/releases/download/v${version}/${filename}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-caddy-'));
  const tarballPath = path.join(tmpDir, filename);

  try {
    console.log('  Downloading Caddy...');
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

    console.log(`  ✓ Caddy v${version} installed to ~/zylos/bin/caddy`);
    return true;
  } catch (err) {
    console.log(`  ⚠ Failed to download Caddy: ${err.message}`);
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
    console.log('  ✓ Port binding capability set (ports 80/443)');
    return true;
  } catch {
    console.log('  ⚠ Could not set port binding capability (sudo required)');
    console.log('    Caddy may not be able to bind to ports 80/443.');
    console.log(`    Fix manually: sudo setcap cap_net_bind_service=+ep "${CADDY_BIN}"`);
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
 * @returns {Promise<boolean>} true if Caddy was set up
 */
async function setupCaddy(skipConfirm) {
  // Check if already fully set up
  if (fs.existsSync(CADDY_BIN) && fs.existsSync(CADDYFILE)) {
    const config = getZylosConfig();
    if (config.domain) {
      const proto = config.protocol || 'https';
      console.log(`  ✓ Caddy already configured (${proto}://${config.domain})`);
      return true;
    }
  }

  // Ask user if they want Caddy
  if (!skipConfirm) {
    const wantCaddy = await promptYesNo('Set up Caddy web server? [Y/n]: ', true);
    if (!wantCaddy) {
      console.log('  Skipping Caddy setup. Run "zylos init" later to set up.');
      return false;
    }
  }

  // Prompt for domain
  const config = getZylosConfig();
  let domain = config.domain || '';
  if (!domain || domain === 'your.domain.com') {
    if (!skipConfirm) {
      domain = await prompt('Enter your domain (e.g., zylos.example.com): ');
    }
    if (!domain) {
      console.log('  ⚠ No domain provided. Skipping Caddy setup.');
      return false;
    }
  }

  // Prompt for protocol
  let protocol = config.protocol || '';
  if (!protocol && !skipConfirm) {
    const useHttps = await promptYesNo('Use HTTPS with auto-certificate? [Y/n]: ', true);
    protocol = useHttps ? 'https' : 'http';
  }
  if (!protocol) protocol = 'https';

  // Save domain and protocol to config.json
  updateZylosConfig({ domain, protocol });
  console.log(`  Domain: ${domain}`);
  console.log(`  Protocol: ${protocol}`);

  // Download Caddy binary
  if (!downloadCaddy()) return false;

  // Set capabilities for port binding
  setCaddyCapabilities();

  // Generate Caddyfile
  fs.mkdirSync(HTTP_DIR, { recursive: true });
  generateCaddyfile(domain, protocol);
  console.log('  ✓ Caddyfile generated at ~/zylos/http/Caddyfile');

  return true;
}

// ── Main init command ───────────────────────────────────────────

export async function initCommand(args) {
  const skipConfirm = args.includes('--yes') || args.includes('-y');

  console.log('\nWelcome to Zylos! Let\'s set up your AI assistant.\n');

  // Step 1: Check prerequisites (always, even on re-init)
  console.log('Checking prerequisites...');

  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    console.log(`  ✗ Node.js ${nodeCheck.version} (requires ${nodeCheck.required})`);
    console.log('    Please upgrade Node.js and try again.');
    process.exit(1);
  }
  console.log(`  ✓ Node.js ${nodeCheck.version}`);

  // Step 2: Check/install tmux
  if (commandExists('tmux')) {
    console.log('  ✓ tmux installed');
  } else {
    console.log('  ✗ tmux not found');
    console.log('    Installing tmux...');
    if (installSystemPackage('tmux')) {
      console.log('  ✓ tmux installed');
    } else {
      console.log('  ✗ Failed to install tmux');
      console.log('    Install manually: brew install tmux (macOS) / apt install tmux (Linux)');
      process.exit(1);
    }
  }

  // Step 3: Check/install git
  if (commandExists('git')) {
    console.log('  ✓ git installed');
  } else {
    console.log('  ✗ git not found');
    console.log('    Installing git...');
    if (installSystemPackage('git')) {
      console.log('  ✓ git installed');
    } else {
      console.log('  ✗ Failed to install git');
      console.log('    Install manually: brew install git (macOS) / apt install git (Linux)');
      process.exit(1);
    }
  }

  // Step 4: Check/install PM2
  if (commandExists('pm2')) {
    console.log('  ✓ PM2 installed');
  } else {
    console.log('  ✗ PM2 not found');
    console.log('    Installing pm2...');
    if (installGlobalPackage('pm2')) {
      console.log('  ✓ PM2 installed');
    } else {
      console.log('  ✗ Failed to install PM2');
      console.log('    Install manually: npm install -g pm2');
      process.exit(1);
    }
  }

  // Step 5: Check/install Claude Code (native installer)
  if (commandExists('claude')) {
    console.log('  ✓ Claude Code installed');
  } else {
    console.log('  ✗ Claude Code not found');
    console.log('    Installing Claude Code (native installer)...');
    try {
      execSync('curl -fsSL https://claude.ai/install.sh | bash', {
        stdio: 'inherit',
        timeout: 300000, // 5 min — downloads ~213MB native binary
      });
      // Native installer puts binary at ~/.local/bin/claude
      // Add to PATH for this process and subsequent commands
      const localBin = path.join(os.homedir(), '.local', 'bin');
      if (!process.env.PATH.split(':').includes(localBin)) {
        process.env.PATH = `${localBin}:${process.env.PATH}`;
      }
      if (commandExists('claude')) {
        console.log('  ✓ Claude Code installed');
      } else {
        console.log('  ✗ Claude Code installed but not found in PATH');
        console.log('    Add ~/.local/bin to your PATH, then run zylos init again.');
        process.exit(1);
      }
    } catch {
      console.log('  ✗ Failed to install Claude Code');
      console.log('    Install manually: curl -fsSL https://claude.ai/install.sh | bash');
      process.exit(1);
    }
  }

  // Step 6: Claude auth check + guided login
  let claudeAuthenticated = false;
  if (commandExists('claude')) {
    claudeAuthenticated = isClaudeAuthenticated();
    if (claudeAuthenticated) {
      console.log('  ✓ Claude Code authenticated');
    } else {
      console.log('  ⚠ Claude Code not authenticated');
      if (!skipConfirm) {
        const doAuth = await promptYesNo('  Authenticate now? [Y/n]: ', true);
        if (doAuth) {
          console.log('  Starting Claude Code for authentication...');
          console.log('  After login, type /exit to return to zylos init.\n');
          // Use async spawn + SIGINT trap so Ctrl+C kills claude
          // without also killing zylos init (they share a process group).
          const sigintListeners = process.rawListeners('SIGINT');
          process.removeAllListeners('SIGINT');
          process.on('SIGINT', () => {}); // ignore during auth
          try {
            const authChild = spawn('claude', [], { stdio: 'inherit' });
            await new Promise((resolve) => authChild.on('close', resolve));
          } catch { /* user may Ctrl+C */ }
          process.removeAllListeners('SIGINT');
          for (const l of sigintListeners) process.on('SIGINT', l);
          // Re-check after auth attempt
          claudeAuthenticated = isClaudeAuthenticated();
          if (claudeAuthenticated) {
            console.log('\n  ✓ Claude Code authenticated');
          } else {
            console.log('\n  ⚠ Authentication not completed.');
            console.log('    Run "claude" to authenticate (or set ANTHROPIC_API_KEY) then "zylos init" again.');
          }
        } else {
          console.log('  Skipped. Run "claude" to authenticate (or set ANTHROPIC_API_KEY) then "zylos init" again.');
        }
      } else {
        console.log('    Run "claude" to authenticate (or set ANTHROPIC_API_KEY) then "zylos init" again.');
      }
    }
  }

  console.log('');

  // Re-init: skip directory creation, just sync + deploy + start
  const installState = detectInstallState();

  if (installState === 'complete') {
    console.log(`Zylos is already initialized at ${ZYLOS_DIR}\n`);

    // Ensure bin directory and PATH are configured (idempotent)
    fs.mkdirSync(BIN_DIR, { recursive: true });
    if (ensureBinInPath()) {
      console.log('Added ~/zylos/bin to PATH');
    }

    const syncResult = syncCoreSkills();
    if (syncResult.updated.length > 0) {
      console.log(`Core Skills updated: ${syncResult.updated.join(', ')}`);
    }
    if (syncResult.installed.length > 0) {
      console.log(`Core Skills installed: ${syncResult.installed.join(', ')}`);
    }

    console.log('Deploying templates...');
    deployTemplates();

    // Timezone (show current, don't re-prompt)
    console.log('Checking timezone...');
    await configureTimezone(skipConfirm, true);

    // Caddy setup (idempotent — skips if already configured)
    console.log('Checking Caddy...');
    await setupCaddy(skipConfirm);

    console.log('Starting services...');
    const servicesStarted = startCoreServices();
    if (servicesStarted > 0) {
      setupPm2Startup();
      console.log(`\n${servicesStarted} service(s) started. Run "zylos status" to check.`);
    } else {
      console.log('\nNo services to start.');
    }

    if (claudeAuthenticated && needsBypassAcceptance()) {
      await guideBypassAcceptance();
    }

    if (!claudeAuthenticated) {
      console.log('\n⚠ Claude Code is not authenticated.');
      console.log('  Run "claude" to authenticate (or set ANTHROPIC_API_KEY) then "zylos init" again.');
    }
    console.log('\nUse "zylos add <component>" to add components.');
    return;
  }

  if (installState === 'incomplete') {
    console.log(`Incomplete installation detected at ${ZYLOS_DIR}`);
    if (!skipConfirm) {
      const answer = await prompt('Continue previous installation or start fresh? [c/f] (c): ');
      if (answer.toLowerCase() === 'f') {
        console.log('Resetting managed state...');
        resetManagedState();
        console.log('Starting fresh...\n');
      } else {
        console.log('Continuing...\n');
      }
    }
  }

  // Step 6: Create directory structure
  console.log(`Install directory: ${ZYLOS_DIR}`);
  console.log('\nSetting up...');
  createDirectoryStructure();
  console.log('  ✓ Created directory structure');

  // Configure PATH for ~/zylos/bin
  if (ensureBinInPath()) {
    console.log('  ✓ Added ~/zylos/bin to PATH');
  }

  // Step 7: Deploy templates
  deployTemplates();
  console.log('  ✓ Templates deployed');

  // Step 8: Configure timezone
  console.log('\nTimezone configuration...');
  await configureTimezone(skipConfirm, false);

  // Step 9: Sync Core Skills
  const syncResult = syncCoreSkills();
  if (syncResult.error) {
    console.log(`  ⚠ ${syncResult.error}`);
  } else {
    const counts = [`${syncResult.installed.length} installed`, `${syncResult.updated.length} updated`];
    console.log(`  ✓ Core Skills synced (${counts.join(', ')})`);
    for (const name of syncResult.installed) {
      console.log(`    + ${name}`);
    }
  }

  // Step 10: Caddy web server setup
  console.log('\nHTTPS setup...');
  await setupCaddy(skipConfirm);

  // Step 11: Start services
  let servicesStarted = 0;
  if (!skipConfirm) {
    const startNow = await promptYesNo('\nStart services now? [Y/n]: ', true);
    if (startNow) {
      console.log('\nStarting services...');
      servicesStarted = startCoreServices();
    }
  } else {
    console.log('\nStarting services...');
    servicesStarted = startCoreServices();
  }

  if (servicesStarted > 0) {
    setupPm2Startup();
  }

  // First-time Claude bypass acceptance (only if authenticated)
  if (claudeAuthenticated && needsBypassAcceptance()) {
    await guideBypassAcceptance();
  }

  // Done
  console.log('\n✓ Zylos initialized successfully!\n');

  if (servicesStarted > 0) {
    console.log(`${servicesStarted} service(s) started. Run "zylos status" to check.\n`);
  }

  console.log('Next steps:');
  if (!claudeAuthenticated) {
    console.log('  claude                           # ⚠ Authenticate first (or set ANTHROPIC_API_KEY)');
  }
  console.log('  zylos add telegram    # Add Telegram bot');
  console.log('  zylos add lark        # Add Lark bot');
  console.log('  zylos status          # Check service status');
  console.log('');
}
