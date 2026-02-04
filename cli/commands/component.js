/**
 * Component management commands
 */

const fs = require('fs');
const path = require('path');
const { ZYLOS_DIR, SKILLS_DIR, COMPONENTS_DIR } = require('../lib/config');
const { loadRegistry } = require('../lib/registry');
const { loadComponents, resolveTarget, outputTask } = require('../lib/components');

async function installComponent(args) {
  const target = args[0];
  if (!target) {
    console.error('Usage: zylos install <name[@version]|org/repo[@version]|github-url>');
    console.log('\nExamples:');
    console.log('  zylos install telegram          # Official component (latest)');
    console.log('  zylos install telegram@0.2.0    # Specific version');
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

  const components = loadComponents();
  if (components[resolved.name]) {
    console.log(`Component "${resolved.name}" is already installed (v${components[resolved.name].version}).`);
    console.log('Use "zylos upgrade" to update.');
    process.exit(0);
  }

  if (resolved.isThirdParty) {
    console.log('⚠️  Third-party component - not verified by Zylos team.');
    console.log(`Repository: https://github.com/${resolved.repo}`);
    console.log('');
  }

  const versionInfo = resolved.version ? ` (v${resolved.version})` : '';
  console.log(`Installing ${resolved.name}${versionInfo} from ${resolved.repo}...`);

  outputTask('install', {
    component: resolved.name,
    repo: resolved.repo,
    version: resolved.version,
    skillsDir: SKILLS_DIR,
    dataDir: path.join(COMPONENTS_DIR, resolved.name),
    isThirdParty: resolved.isThirdParty,
    steps: [
      `Clone https://github.com/${resolved.repo} to ${SKILLS_DIR}/${resolved.name}`,
      resolved.version ? `Checkout version ${resolved.version}: git checkout v${resolved.version}` : null,
      `Create data directory ${COMPONENTS_DIR}/${resolved.name}`,
      `Read SKILL.md for lifecycle configuration`,
      `Run npm install if package.json exists`,
      `Execute post-install hook if defined`,
      `Register PM2 service if service defined in SKILL.md`,
      `Record installation in ${ZYLOS_DIR}/components.json`,
    ].filter(Boolean),
  });
}

async function upgradeComponent(args) {
  const upgradeSelf = args[0] === '--self';
  const upgradeAll = args[0] === '--all';
  const target = (upgradeSelf || upgradeAll) ? null : args[0];

  // Handle --self: upgrade zylos-core itself
  if (upgradeSelf) {
    return upgradeSelfCore();
  }

  const components = loadComponents();
  const componentNames = Object.keys(components);

  if (componentNames.length === 0 && !upgradeAll) {
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
    console.error('       zylos upgrade --self');
    console.log('\nExamples:');
    console.log('  zylos upgrade telegram    # Upgrade specific component');
    console.log('  zylos upgrade --all       # Upgrade all components');
    console.log('  zylos upgrade --self      # Upgrade zylos-core itself');
    process.exit(1);
  }

  if (toUpgrade.length === 0) {
    console.log('No components to upgrade.');
    return;
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
 * Upgrade zylos-core itself
 */
async function upgradeSelfCore() {
  // zylos-core is installed at ~/.claude/skills (or wherever SKILLS_DIR points)
  // The CLI and core files are in the parent of skills dir
  const coreDir = path.join(SKILLS_DIR, '..');  // ~/.claude

  console.log('Checking for zylos-core updates...');

  outputTask('self_upgrade', {
    target: 'zylos-core',
    repo: 'zylos-ai/zylos-core',
    coreDir: coreDir,
    steps: [
      '1. Check git status for local modifications in zylos-core',
      '2. git fetch to check for updates',
      '3. Show CHANGELOG.md and VERSION diff',
      '4. Ask user for confirmation',
      '5. If user confirms:',
      '   a. Create backup (git stash + record rollback point)',
      '   b. Stop core services (scheduler, c4-dispatcher, etc.)',
      '   c. git pull to update code',
      '   d. npm install if package.json changed',
      '   e. Restart core services',
      '   f. Verify services are running',
      '   g. If failed, rollback and restart',
      '6. Report new version',
    ],
  });
}

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
    console.log(`${comp.name}@${comp.latest || '?'} ${status}`);
    console.log(`  ${comp.description}`);
    console.log(`  Type: ${comp.type} | Repo: ${comp.repo}`);
    console.log('');
  }

  console.log(`Found ${results.length} component(s).`);
  console.log('\nUse "zylos install <name>" to install a component.');
}

module.exports = {
  installComponent,
  upgradeComponent,
  uninstallComponent,
  listComponents,
  searchComponents,
};
