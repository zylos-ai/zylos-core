#!/usr/bin/env node

/**
 * Zylos CLI - Main entry point
 * Usage: zylos <command> [options]
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const SKILLS_DIR = path.join(process.env.HOME, '.claude', 'skills');
const COMPONENTS_DIR = path.join(ZYLOS_DIR, 'components');
const REGISTRY_URL = 'https://raw.githubusercontent.com/zylos-ai/zylos-registry/main/registry.json';

// Built-in registry for official components (fallback)
const BUILTIN_REGISTRY = {
  telegram: {
    name: 'telegram',
    description: 'Telegram Bot communication channel',
    repo: 'zylos-ai/zylos-telegram',
    type: 'communication',
    version: '1.0.0',
  },
  lark: {
    name: 'lark',
    description: 'Lark/Feishu Bot communication channel',
    repo: 'zylos-ai/zylos-lark',
    type: 'communication',
    version: '1.0.0',
  },
  scheduler: {
    name: 'scheduler',
    description: 'Task scheduling and automation',
    repo: 'zylos-ai/zylos-scheduler',
    type: 'capability',
    version: '1.0.0',
  },
};

const commands = {
  // Service management
  status: showStatus,
  logs: showLogs,
  start: startServices,
  stop: stopServices,
  restart: restartServices,
  // Component management
  install: installComponent,
  upgrade: upgradeComponent,
  uninstall: uninstallComponent,
  list: listComponents,
  search: searchComponents,
  help: showHelp,
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (commands[command]) {
    await commands[command](args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
}

function showStatus() {
  console.log('Zylos Status\n============\n');

  // Check Claude status
  const statusFile = path.join(process.env.HOME, '.claude-status');
  if (fs.existsSync(statusFile)) {
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      console.log(`Claude: ${status.state.toUpperCase()}`);
      if (status.idle_seconds !== undefined) {
        console.log(`  Idle: ${status.idle_seconds}s`);
      }
      if (status.last_check_human) {
        console.log(`  Last check: ${status.last_check_human}`);
      }
    } catch (e) {
      console.log('Claude: UNKNOWN (status file unreadable)');
    }
  } else {
    console.log('Claude: UNKNOWN (no status file)');
  }

  console.log('');

  // Check PM2 services
  console.log('Services (PM2):');
  try {
    const pm2Output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(pm2Output);
    if (processes.length === 0) {
      console.log('  No services running');
    } else {
      processes.forEach(p => {
        const status = p.pm2_env.status === 'online' ? '✓' : '✗';
        console.log(`  ${status} ${p.name}: ${p.pm2_env.status}`);
      });
    }
  } catch (e) {
    console.log('  PM2 not available or no services');
  }

  console.log('');

  // Check disk space
  console.log('Disk:');
  try {
    const df = execSync(`df -h ${ZYLOS_DIR} | tail -1`, { encoding: 'utf8' });
    const parts = df.trim().split(/\s+/);
    console.log(`  Used: ${parts[2]} / ${parts[1]} (${parts[4]})`);
  } catch (e) {
    console.log('  Unable to check');
  }
}

function showLogs(args) {
  const logType = args[0] || 'activity';

  const logFiles = {
    activity: path.join(ZYLOS_DIR, 'activity-log.txt'),
    scheduler: path.join(ZYLOS_DIR, 'scheduler-log.txt'),
    caddy: path.join(ZYLOS_DIR, 'logs', 'caddy-access.log'),
  };

  if (logType === 'pm2') {
    // Show PM2 logs
    const pm2 = spawn('pm2', ['logs', '--lines', '50'], { stdio: 'inherit' });
    pm2.on('close', () => process.exit(0));
    return;
  }

  const logFile = logFiles[logType];
  if (!logFile) {
    console.error(`Unknown log type: ${logType}`);
    console.log('Available: activity, scheduler, caddy, pm2');
    process.exit(1);
  }

  if (!fs.existsSync(logFile)) {
    console.log(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  // Tail the log file
  const tail = spawn('tail', ['-f', '-n', '50', logFile], { stdio: 'inherit' });
  tail.on('close', () => process.exit(0));
}

function startServices() {
  console.log('Starting Zylos services...');

  const services = [
    { name: 'activity-monitor', script: path.join(SKILLS_DIR, 'self-maintenance', 'activity-monitor.js') },
    { name: 'scheduler', script: path.join(SKILLS_DIR, 'scheduler', 'scheduler.js'), env: `NODE_ENV=production ZYLOS_DIR=${ZYLOS_DIR}` },
    { name: 'c4-dispatcher', script: path.join(SKILLS_DIR, 'comm-bridge', 'c4-dispatcher.js') },
    { name: 'web-console', script: path.join(SKILLS_DIR, 'web-console', 'server.js'), env: `WEB_CONSOLE_PORT=3456 ZYLOS_DIR=${ZYLOS_DIR}` },
  ];

  let started = 0;
  for (const svc of services) {
    if (!fs.existsSync(svc.script)) {
      console.log(`  Skipping ${svc.name} (not installed)`);
      continue;
    }
    try {
      const envOpts = svc.env ? svc.env.split(' ').map(e => `--env ${e}`).join(' ') : '';
      execSync(`pm2 start ${svc.script} --name ${svc.name} ${envOpts} 2>/dev/null`, { stdio: 'pipe' });
      console.log(`  ✓ ${svc.name}`);
      started++;
    } catch (e) {
      // Already running or other error, try restart
      try {
        execSync(`pm2 restart ${svc.name} 2>/dev/null`, { stdio: 'pipe' });
        console.log(`  ✓ ${svc.name} (restarted)`);
        started++;
      } catch (e2) {
        console.log(`  ✗ ${svc.name} (failed)`);
      }
    }
  }

  if (started > 0) {
    execSync('pm2 save 2>/dev/null', { stdio: 'pipe' });
    console.log(`\n${started} services started. Run "zylos status" to check.`);
  } else {
    console.log('\nNo services started.');
  }
}

function stopServices() {
  console.log('Stopping Zylos services...');
  const services = ['activity-monitor', 'scheduler', 'c4-dispatcher', 'web-console'];
  try {
    execSync(`pm2 stop ${services.join(' ')} 2>/dev/null || true`, { stdio: 'inherit' });
    console.log('Services stopped.');
  } catch (e) {
    console.error('Failed to stop services');
  }
}

function restartServices() {
  console.log('Restarting Zylos services...');
  const services = ['activity-monitor', 'scheduler', 'c4-dispatcher', 'web-console'];
  try {
    execSync(`pm2 restart ${services.join(' ')} 2>/dev/null || true`, { stdio: 'inherit' });
    console.log('Services restarted.');
  } catch (e) {
    console.error('Failed to restart services');
  }
}

// ============ Component Management ============

/**
 * Load registry (try remote first, fallback to built-in)
 */
async function loadRegistry() {
  try {
    const https = require('https');
    return new Promise((resolve) => {
      const req = https.get(REGISTRY_URL, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(BUILTIN_REGISTRY);
          }
        });
      });
      req.on('error', () => resolve(BUILTIN_REGISTRY));
      req.on('timeout', () => {
        req.destroy();
        resolve(BUILTIN_REGISTRY);
      });
    });
  } catch {
    return BUILTIN_REGISTRY;
  }
}

/**
 * Load installed components from components.json
 */
function loadComponents() {
  const componentsFile = path.join(ZYLOS_DIR, 'components.json');
  if (fs.existsSync(componentsFile)) {
    try {
      return JSON.parse(fs.readFileSync(componentsFile, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save installed components to components.json
 */
function saveComponents(components) {
  const componentsFile = path.join(ZYLOS_DIR, 'components.json');
  fs.writeFileSync(componentsFile, JSON.stringify(components, null, 2));
}

/**
 * Resolve component target from name or URL
 * @returns {object} { name, repo, isThirdParty }
 */
async function resolveTarget(nameOrUrl) {
  // Check if it's a GitHub URL
  const githubMatch = nameOrUrl.match(/github\.com\/([^\/]+\/[^\/]+)/);
  if (githubMatch) {
    const repo = githubMatch[1].replace(/\.git$/, '');
    const name = repo.split('/')[1].replace(/^zylos-/, '');
    return { name, repo, isThirdParty: !repo.startsWith('zylos-ai/') };
  }

  // Check if it's in format org/repo
  if (nameOrUrl.includes('/')) {
    const name = nameOrUrl.split('/')[1].replace(/^zylos-/, '');
    return { name, repo: nameOrUrl, isThirdParty: !nameOrUrl.startsWith('zylos-ai/') };
  }

  // Look up in registry
  const registry = await loadRegistry();
  if (registry[nameOrUrl]) {
    return {
      name: nameOrUrl,
      repo: registry[nameOrUrl].repo,
      isThirdParty: false,
    };
  }

  // Unknown - treat as third party
  return { name: nameOrUrl, repo: null, isThirdParty: true };
}

/**
 * Output task for Claude to execute via C4
 */
function outputTask(action, data) {
  console.log('\n[ZYLOS_TASK]');
  console.log(JSON.stringify({ action, ...data }, null, 2));
  console.log('[/ZYLOS_TASK]\n');
}

/**
 * Install a component
 */
async function installComponent(args) {
  const target = args[0];
  if (!target) {
    console.error('Usage: zylos install <name|org/repo|github-url>');
    console.log('\nExamples:');
    console.log('  zylos install telegram          # Official component');
    console.log('  zylos install kevin/whatsapp    # Third-party');
    console.log('  zylos install https://github.com/kevin/zylos-whatsapp');
    process.exit(1);
  }

  const resolved = await resolveTarget(target);

  if (!resolved.repo) {
    console.error(`Unknown component: ${target}`);
    console.log('Use "zylos search <keyword>" to find available components.');
    process.exit(1);
  }

  // Check if already installed
  const components = loadComponents();
  if (components[resolved.name]) {
    console.log(`Component "${resolved.name}" is already installed (v${components[resolved.name].version}).`);
    console.log('Use "zylos upgrade" to update.');
    process.exit(0);
  }

  // Warn for third-party components
  if (resolved.isThirdParty) {
    console.log('⚠️  Third-party component - not verified by Zylos team.');
    console.log(`Repository: https://github.com/${resolved.repo}`);
    console.log('');
  }

  console.log(`Installing ${resolved.name} from ${resolved.repo}...`);

  // Output task for Claude to execute
  outputTask('install', {
    component: resolved.name,
    repo: resolved.repo,
    skillsDir: SKILLS_DIR,
    dataDir: path.join(COMPONENTS_DIR, resolved.name),
    isThirdParty: resolved.isThirdParty,
    steps: [
      `Clone https://github.com/${resolved.repo} to ${SKILLS_DIR}/${resolved.name}`,
      `Create data directory ${COMPONENTS_DIR}/${resolved.name}`,
      `Read SKILL.md for lifecycle configuration`,
      `Run npm install if package.json exists`,
      `Execute post-install hook if defined`,
      `Register PM2 service if service defined in SKILL.md`,
      `Record installation in ${ZYLOS_DIR}/components.json`,
    ],
  });
}

/**
 * Upgrade a component
 */
async function upgradeComponent(args) {
  const upgradeAll = args[0] === '--all';
  const target = upgradeAll ? null : args[0];

  const components = loadComponents();
  const componentNames = Object.keys(components);

  if (componentNames.length === 0) {
    console.log('No components installed.');
    process.exit(0);
  }

  let toUpgrade = [];

  if (upgradeAll) {
    toUpgrade = componentNames;
  } else if (target) {
    if (!components[target]) {
      console.error(`Component "${target}" is not installed.`);
      process.exit(1);
    }
    toUpgrade = [target];
  } else {
    console.error('Usage: zylos upgrade <name>');
    console.error('       zylos upgrade --all');
    console.log('\nExamples:');
    console.log('  zylos upgrade telegram    # Upgrade specific component');
    console.log('  zylos upgrade --all       # Upgrade all components');
    process.exit(1);
  }

  console.log(`Checking upgrades for: ${toUpgrade.join(', ')}...`);

  outputTask('upgrade', {
    components: toUpgrade.map(name => ({
      name,
      repo: components[name].repo,
      currentVersion: components[name].version,
      skillDir: path.join(SKILLS_DIR, name),
      dataDir: path.join(COMPONENTS_DIR, name),
    })),
    steps: [
      'For each component:',
      '1. Check git status for local modifications',
      '2. Fetch remote changes and compare versions',
      '3. Show CHANGELOG.md diff for user confirmation',
      '4. If user confirms:',
      '   a. Create backup (git stash + record rollback point)',
      '   b. Execute pre-upgrade hook if defined',
      '   c. Stop service if running',
      '   d. Pull changes + npm install',
      '   e. Execute post-upgrade hook if defined',
      '   f. Restart service',
      '   g. Verify service status',
      '   h. If failed, rollback automatically',
      '5. Update version in components.json',
    ],
  });
}

/**
 * Uninstall a component
 */
async function uninstallComponent(args) {
  const target = args[0];
  const purge = args.includes('--purge');

  if (!target) {
    console.error('Usage: zylos uninstall <name> [--purge]');
    console.log('\nOptions:');
    console.log('  --purge    Also remove data directory');
    process.exit(1);
  }

  const components = loadComponents();
  if (!components[target]) {
    console.error(`Component "${target}" is not installed.`);
    process.exit(1);
  }

  console.log(`Uninstalling ${target}...`);
  if (purge) {
    console.log('(with --purge: data directory will also be removed)');
  }

  outputTask('uninstall', {
    component: target,
    skillDir: path.join(SKILLS_DIR, target),
    dataDir: path.join(COMPONENTS_DIR, target),
    purge,
    steps: [
      `Stop PM2 service "zylos-${target}" if running`,
      `Remove from PM2: pm2 delete zylos-${target}`,
      `Remove skill directory: ${SKILLS_DIR}/${target}`,
      purge ? `Remove data directory: ${COMPONENTS_DIR}/${target}` : '(Keep data directory)',
      `Remove from ${ZYLOS_DIR}/components.json`,
    ],
  });
}

/**
 * List installed components
 */
async function listComponents() {
  const components = loadComponents();
  const names = Object.keys(components);

  if (names.length === 0) {
    console.log('No components installed.');
    console.log('\nUse "zylos search <keyword>" to find available components.');
    console.log('Use "zylos install <name>" to install a component.');
    return;
  }

  console.log('Installed Components\n====================\n');

  for (const name of names) {
    const comp = components[name];
    const skillDir = path.join(SKILLS_DIR, name);
    const installed = fs.existsSync(skillDir) ? '✓' : '✗';

    console.log(`${installed} ${name} (v${comp.version})`);
    console.log(`  Type: ${comp.type || 'unknown'}`);
    console.log(`  Repo: ${comp.repo}`);
    console.log(`  Installed: ${comp.installedAt || 'unknown'}`);
    console.log('');
  }
}

/**
 * Search for components
 */
async function searchComponents(args) {
  const keyword = args[0] || '';

  console.log('Searching components...\n');

  const registry = await loadRegistry();
  const results = [];

  for (const [name, info] of Object.entries(registry)) {
    if (!keyword ||
        name.includes(keyword) ||
        (info.description && info.description.toLowerCase().includes(keyword.toLowerCase()))) {
      results.push({ name, ...info });
    }
  }

  if (results.length === 0) {
    console.log('No components found.');
    if (keyword) {
      console.log(`\nTry searching without keyword or install directly:`);
      console.log(`  zylos install <github-url>`);
    }
    return;
  }

  console.log('Available Components\n====================\n');

  const installed = loadComponents();

  for (const comp of results) {
    const status = installed[comp.name] ? '[installed]' : '';
    console.log(`${comp.name} ${status}`);
    console.log(`  ${comp.description}`);
    console.log(`  Type: ${comp.type} | Repo: ${comp.repo}`);
    console.log('');
  }

  console.log(`Found ${results.length} component(s).`);
  console.log('\nUse "zylos install <name>" to install a component.');
}

function showHelp() {
  console.log(`
Zylos CLI

Usage: zylos <command> [options]

Service Management:
  status              Show system status
  logs [type]         Show logs (activity|scheduler|caddy|pm2)
  start               Start all services
  stop                Stop all services
  restart             Restart all services

Component Management:
  install <target>    Install a component
                      target: name | org/repo | github-url
  upgrade <name>      Upgrade a specific component
  upgrade --all       Upgrade all components
  uninstall <name>    Uninstall a component (--purge for data)
  list                List installed components
  search [keyword]    Search available components

Other:
  help                Show this help

Examples:
  zylos status
  zylos logs activity

  zylos install telegram
  zylos install kevin/whatsapp
  zylos upgrade telegram
  zylos upgrade --all
  zylos uninstall telegram --purge
  zylos list
  zylos search bot
`);
}

main().catch(console.error);
