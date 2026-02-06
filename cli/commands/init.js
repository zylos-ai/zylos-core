/**
 * zylos init - Initialize Zylos environment
 *
 * Sets up the directory structure, checks prerequisites,
 * syncs Core Skills, and optionally starts services.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawnSync } = require('child_process');
const { ZYLOS_DIR, SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, COMPONENTS_FILE } = require('../lib/config');
const { generateManifest, saveManifest } = require('../lib/manifest');

// Source directory for Core Skills (shipped with zylos package)
const CORE_SKILLS_SRC = path.join(__dirname, '..', '..', 'skills');

// Minimum Node.js version
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 20;

// ── Prompt utilities ────────────────────────────────────────────────

function prompt(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptYesNo(question, defaultYes = false) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
  return prompt(question).then((answer) => {
    if (!answer) return defaultYes;
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  });
}

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
  const services = [
    { name: 'activity-monitor', entry: 'self-maintenance/activity-monitor.js' },
    { name: 'scheduler', entry: 'scheduler/scheduler.js' },
    { name: 'c4-dispatcher', entry: 'comm-bridge/c4-dispatcher.js' },
    { name: 'web-console', entry: 'web-console/server.js' },
  ];

  let started = 0;
  for (const svc of services) {
    const script = path.join(SKILLS_DIR, svc.entry);
    if (!fs.existsSync(script)) continue;

    try {
      execSync(`pm2 start "${script}" --name "${svc.name}" 2>/dev/null`, { stdio: 'pipe' });
      console.log(`  ✓ ${svc.name}`);
      started++;
    } catch {
      // May already be running
      try {
        execSync(`pm2 restart "${svc.name}" 2>/dev/null`, { stdio: 'pipe' });
        console.log(`  ✓ ${svc.name} (restarted)`);
        started++;
      } catch {
        console.log(`  - ${svc.name} (not available)`);
      }
    }
  }

  if (started > 0) {
    try {
      execSync('pm2 save 2>/dev/null', { stdio: 'pipe' });
    } catch {
      // pm2 save failure is non-critical
    }
  }

  return started;
}

// ── Main init command ───────────────────────────────────────────────

async function initCommand(args) {
  const skipConfirm = args.includes('--yes') || args.includes('-y');

  console.log('\nWelcome to Zylos! Let\'s set up your AI assistant.\n');

  // Step 0: Check for existing installation
  const installState = detectInstallState();

  if (installState === 'complete') {
    console.log(`Zylos is already initialized at ${ZYLOS_DIR}`);
    console.log('\nUse "zylos status" to check services.');
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
  console.log(`  ✓ Created directory structure`);

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

module.exports = { initCommand };
