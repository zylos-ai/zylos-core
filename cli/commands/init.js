/**
 * zylos init - Initialize Zylos environment
 *
 * Sets up the directory structure, checks prerequisites,
 * syncs Core Skills, and optionally starts services.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { ZYLOS_DIR, SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, COMPONENTS_FILE } from '../lib/config.js';
import { generateManifest, saveManifest } from '../lib/manifest.js';
import { prompt, promptYesNo } from '../lib/prompts.js';

// Source directory for Core Skills (shipped with zylos package)
const CORE_SKILLS_SRC = path.join(import.meta.dirname, '..', '..', 'skills');

// Minimum Node.js version
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 20;

// ── Prerequisite checks ─────────────────────────────────────────────

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

// ── Installation state detection ────────────────────────────────────

/**
 * Detect the current installation state.
 * @returns {'fresh'|'incomplete'|'complete'}
 */
function detectInstallState() {
  if (!fs.existsSync(ZYLOS_DIR)) return 'fresh';

  const markers = [
    CONFIG_DIR,
    SKILLS_DIR,
    COMPONENTS_FILE,
  ];

  const existing = markers.filter((m) => fs.existsSync(m));

  if (existing.length === 0) return 'fresh';
  if (existing.length === markers.length) return 'complete';
  return 'incomplete';
}

// ── Directory structure ─────────────────────────────────────────────

function createDirectoryStructure() {
  const dirs = [
    ZYLOS_DIR,
    SKILLS_DIR,
    CONFIG_DIR,
    COMPONENTS_DIR,
    LOCKS_DIR,
    path.join(ZYLOS_DIR, 'memory'),
    path.join(ZYLOS_DIR, 'logs'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Initialize components.json if it doesn't exist
  if (!fs.existsSync(COMPONENTS_FILE)) {
    fs.writeFileSync(COMPONENTS_FILE, JSON.stringify({}, null, 2));
  }
}

// ── Core Skills sync ────────────────────────────────────────────────

/**
 * Sync Core Skills from the zylos package to SKILLS_DIR.
 * Only copies skills that don't already exist (preserves user modifications).
 * @returns {{ synced: string[], skipped: string[] }}
 */
function syncCoreSkills() {
  if (!fs.existsSync(CORE_SKILLS_SRC)) {
    return { synced: [], skipped: [], error: 'Core Skills source not found' };
  }

  const synced = [];
  const skipped = [];

  const entries = fs.readdirSync(CORE_SKILLS_SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(CORE_SKILLS_SRC, entry.name);
    const destDir = path.join(SKILLS_DIR, entry.name);

    if (fs.existsSync(destDir)) {
      skipped.push(entry.name);
      continue;
    }

    // Copy skill directory
    try {
      execSync(`cp -r "${srcDir}" "${destDir}"`, { stdio: 'pipe' });

      // Generate manifest for the newly synced skill
      const manifest = generateManifest(destDir);
      saveManifest(destDir, manifest);

      synced.push(entry.name);
    } catch {
      console.log(`  Warning: Failed to sync ${entry.name}`);
    }
  }

  return { synced, skipped };
}

// ── Service startup ─────────────────────────────────────────────────

function startCoreServices() {
  // Step 1: Install dependencies for all skills that need them
  const skillEntries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const pkgPath = path.join(skillDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        const nmDir = path.join(skillDir, 'node_modules');
        if (!fs.existsSync(nmDir)) {
          console.log(`  Installing ${entry.name} dependencies...`);
          execSync('npm install --production', {
            cwd: skillDir,
            stdio: 'pipe',
            timeout: 120000,
          });
        }
      }
    } catch {
      console.log(`  ⚠ Failed to install ${entry.name} dependencies`);
    }
  }

  // Step 2: Initialize databases (comm-bridge)
  const dbInitScript = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-db.js');
  const dbInitSql = path.join(SKILLS_DIR, 'comm-bridge', 'init-db.sql');
  if (fs.existsSync(dbInitSql) && fs.existsSync(dbInitScript)) {
    try {
      execSync(`node "${dbInitScript}" init`, {
        cwd: path.join(SKILLS_DIR, 'comm-bridge'),
        stdio: 'pipe',
        timeout: 10000,
      });
      console.log('  ✓ Database initialized');
    } catch {
      // DB may already be initialized
    }
  }

  // Step 3: Copy ecosystem.config.cjs template and start services via PM2
  const pm2Dir = path.join(ZYLOS_DIR, 'pm2');
  const ecosystemSrc = path.join(import.meta.dirname, '..', '..', 'templates', 'pm2', 'ecosystem.config.cjs');
  const ecosystemDest = path.join(pm2Dir, 'ecosystem.config.cjs');

  if (!fs.existsSync(ecosystemSrc)) {
    console.log('  ⚠ ecosystem.config.cjs template not found');
    return 0;
  }

  fs.mkdirSync(pm2Dir, { recursive: true });
  fs.copyFileSync(ecosystemSrc, ecosystemDest);

  try {
    // pm2 start will start new processes and restart existing ones by name
    execSync(`pm2 start "${ecosystemDest}" --update-env`, { stdio: 'pipe', timeout: 30000 });
    execSync('pm2 save', { stdio: 'pipe' });
  } catch (err) {
    console.log(`  ⚠ Failed to start services: ${err.message}`);
    return 0;
  }

  // Count started services
  try {
    const list = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const procs = JSON.parse(list);
    let started = 0;
    for (const proc of procs) {
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

// ── Main init command ───────────────────────────────────────────────

export async function initCommand(args) {
  const skipConfirm = args.includes('--yes') || args.includes('-y');

  console.log('\nWelcome to Zylos! Let\'s set up your AI assistant.\n');

  // Step 0: Check for existing installation
  const installState = detectInstallState();

  if (installState === 'complete') {
    console.log(`Zylos is already initialized at ${ZYLOS_DIR}\n`);

    // Sync Core Skills (may have updates)
    const syncResult = syncCoreSkills();
    if (syncResult.synced.length > 0) {
      console.log(`Core Skills updated: ${syncResult.synced.join(', ')}`);
    }

    // Start/restart services
    console.log('Starting services...');
    const servicesStarted = startCoreServices();
    if (servicesStarted > 0) {
      console.log(`\n${servicesStarted} service(s) started. Run "zylos status" to check.`);
    } else {
      console.log('\nNo services to start.');
    }
    console.log('Use "zylos add <component>" to add components.');
    return;
  }

  if (installState === 'incomplete') {
    console.log(`Incomplete installation detected at ${ZYLOS_DIR}`);
    if (!skipConfirm) {
      const answer = await prompt('Continue previous installation or start fresh? [c/f] (c): ');
      if (answer.toLowerCase() === 'f') {
        console.log('Starting fresh...\n');
      } else {
        console.log('Continuing...\n');
      }
    }
  }

  // Step 1: Check prerequisites
  console.log('Checking prerequisites...');

  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    console.log(`  ✗ Node.js ${nodeCheck.version} (requires ${nodeCheck.required})`);
    console.log('    Please upgrade Node.js and try again.');
    process.exit(1);
  }
  console.log(`  ✓ Node.js ${nodeCheck.version}`);

  // Step 2: Check/install PM2
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

  // Step 3: Check/install Claude Code
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

  // Step 4: Claude auth check
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

  // Step 5: Show install directory
  console.log(`Install directory: ${ZYLOS_DIR}`);

  // Step 6: Create directory structure
  console.log('\nSetting up...');
  createDirectoryStructure();
  console.log('  ✓ Created directory structure');

  // Step 7: Sync Core Skills
  const syncResult = syncCoreSkills();
  if (syncResult.error) {
    console.log(`  ⚠ ${syncResult.error}`);
  } else {
    console.log(`  ✓ Core Skills synced (${syncResult.synced.length} installed, ${syncResult.skipped.length} already present)`);
    if (syncResult.synced.length > 0) {
      for (const name of syncResult.synced) {
        console.log(`    + ${name}`);
      }
    }
  }

  // Step 8: Ask about starting services
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
