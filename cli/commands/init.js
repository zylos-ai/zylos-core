/**
 * zylos init - Initialize Zylos environment
 *
 * Sets up the directory structure, checks prerequisites,
 * syncs Core Skills, deploys templates, and starts services.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { ZYLOS_DIR, SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, COMPONENTS_FILE } from '../lib/config.js';
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
    path.join(ZYLOS_DIR, 'memory'),
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
      if (fs.existsSync(path.join(skillDir, 'node_modules'))) continue;

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

  // Step 5: Check/install Claude Code
  if (commandExists('claude')) {
    console.log('  ✓ Claude Code installed');
  } else {
    console.log('  ✗ Claude Code not found');
    console.log('    Installing @anthropic-ai/claude-code...');
    if (installGlobalPackage('@anthropic-ai/claude-code')) {
      console.log('  ✓ Claude Code installed');
    } else {
      console.log('  ✗ Failed to install Claude Code');
      console.log('    Install manually: npm install -g @anthropic-ai/claude-code');
      process.exit(1);
    }
  }

  // Step 6: Claude auth check
  if (commandExists('claude')) {
    try {
      const result = spawnSync('claude', ['auth', 'status'], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 10000,
      });
      if (result.status === 0) {
        console.log('  ✓ Claude Code authenticated');
      } else {
        console.log('  ⚠ Claude Code not authenticated');
        console.log('    Run "claude auth" to authenticate after init.');
      }
    } catch {
      console.log('  ⚠ Could not check Claude Code auth status');
    }
  }

  console.log('');

  // Re-init: skip directory creation, just sync + deploy + start
  const installState = detectInstallState();

  if (installState === 'complete') {
    console.log(`Zylos is already initialized at ${ZYLOS_DIR}\n`);

    const syncResult = syncCoreSkills();
    if (syncResult.updated.length > 0) {
      console.log(`Core Skills updated: ${syncResult.updated.join(', ')}`);
    }
    if (syncResult.installed.length > 0) {
      console.log(`Core Skills installed: ${syncResult.installed.join(', ')}`);
    }

    console.log('Deploying templates...');
    deployTemplates();

    console.log('Starting services...');
    const servicesStarted = startCoreServices();
    if (servicesStarted > 0) {
      console.log(`\n${servicesStarted} service(s) started. Run "zylos status" to check.`);
    } else {
      console.log('\nNo services to start.');
    }

    if (needsBypassAcceptance()) {
      await guideBypassAcceptance();
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

  // Step 7: Deploy templates
  deployTemplates();
  console.log('  ✓ Templates deployed');

  // Step 8: Sync Core Skills
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

  // Step 9: Start services
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

  // First-time Claude bypass acceptance
  if (needsBypassAcceptance()) {
    await guideBypassAcceptance();
  }

  // Done
  console.log('\n✓ Zylos initialized successfully!\n');

  if (servicesStarted > 0) {
    console.log(`${servicesStarted} service(s) started. Run "zylos status" to check.\n`);
  }

  console.log('Next steps:');
  console.log('  zylos add telegram    # Add Telegram bot');
  console.log('  zylos add lark        # Add Lark bot');
  console.log('  zylos status          # Check service status');
  console.log('');
}
