/**
 * Component management commands
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ZYLOS_DIR, SKILLS_DIR, COMPONENTS_DIR } = require('../lib/config');

/**
 * Prompt user for confirmation
 * @param {string} question - The question to ask
 * @returns {Promise<boolean>} - true if user confirmed, false otherwise
 */
function promptConfirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}
const { loadRegistry } = require('../lib/registry');
const { loadComponents, resolveTarget, outputTask } = require('../lib/components');
const { checkForUpdates, runUpgrade } = require('../lib/upgrade');

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
  // Parse flags
  const checkOnly = args.includes('--check');
  const jsonOutput = args.includes('--json');
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const explicitConfirm = args.includes('confirm');
  const upgradeSelf = args.includes('--self');
  const upgradeAll = args.includes('--all');

  // Get target component (filter out flags)
  const target = args.find(a => !a.startsWith('-') && a !== 'confirm');

  // Handle --self: upgrade zylos-core itself (legacy mode)
  if (upgradeSelf) {
    return upgradeSelfCore();
  }

  // Handle --all: upgrade all components
  if (upgradeAll) {
    return upgradeAllComponents({ checkOnly, jsonOutput, skipConfirm });
  }

  // Validate target
  if (!target) {
    console.error('Usage: zylos upgrade <name> [options]');
    console.error('       zylos upgrade <name> confirm');
    console.error('       zylos upgrade --all');
    console.error('       zylos upgrade --self');
    console.log('\nOptions:');
    console.log('  --check    Check for updates only');
    console.log('  --json     Output in JSON format');
    console.log('  --yes, -y  Skip confirmation');
    console.log('  confirm    Execute upgrade (for async confirmation)');
    console.log('\nExamples:');
    console.log('  zylos upgrade telegram --check --json');
    console.log('  zylos upgrade telegram --yes');
    console.log('  zylos upgrade telegram confirm');
    process.exit(1);
  }

  // Verify component is installed (both in components.json and skill directory)
  const components = loadComponents();
  const skillDir = path.join(SKILLS_DIR, target);

  if (!components[target]) {
    const result = {
      action: 'check',
      component: target,
      error: 'component_not_registered',
      message: `组件 '${target}' 未在 components.json 中注册`,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.message}`);
    }
    process.exit(1);
  }

  if (!fs.existsSync(skillDir)) {
    const result = {
      action: 'check',
      component: target,
      error: 'skill_dir_not_found',
      message: `组件目录不存在: ${skillDir}`,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.message}`);
    }
    process.exit(1);
  }

  // Mode 1: Check only (--check)
  if (checkOnly) {
    return handleCheckOnly(target, { jsonOutput });
  }

  // Mode 2: Execute upgrade (--yes or confirm)
  if (skipConfirm || explicitConfirm) {
    return handleExecuteUpgrade(target, { jsonOutput });
  }

  // Mode 3: Interactive (default) - show info and prompt
  return handleInteractive(target, { jsonOutput });
}

/**
 * Handle --check flag: check for updates only
 */
async function handleCheckOnly(component, { jsonOutput }) {
  const result = checkForUpdates(component);

  if (jsonOutput) {
    const output = {
      action: 'check',
      component,
      ...result,
    };
    console.log(JSON.stringify(output, null, 2));
    if (!result.success) {
      process.exit(1);
    }
  } else {
    if (!result.success) {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }

    if (!result.hasUpdate) {
      console.log(`✓ ${component} is up to date (v${result.current})`);
    } else {
      console.log(`${component}: ${result.current} → ${result.latest}`);
      if (result.localChanges) {
        console.log(`\n⚠️  Local modifications detected:`);
        result.localChanges.forEach(c => console.log(`  ${c}`));
      }
      if (result.changelog) {
        console.log(`\nChangelog:\n${result.changelog}`);
      }
      console.log(`\nRun "zylos upgrade ${component} --yes" to upgrade.`);
    }
  }
}

/**
 * Handle --yes or confirm: execute upgrade
 */
async function handleExecuteUpgrade(component, { jsonOutput }) {
  if (!jsonOutput) {
    console.log(`Upgrading ${component}...`);
  }

  const result = runUpgrade(component);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exit(1);
    }
  } else {
    if (result.success) {
      // Print step progress
      for (const step of result.steps) {
        const icon = step.status === 'done' ? '✓' :
                     step.status === 'skipped' ? '○' : '✗';
        const msg = step.message ? ` (${step.message})` : '';
        console.log(`  [${step.step}/9] ${step.name}${msg} ${icon}`);
      }

      console.log(`\n✓ ${component} 升级完成: ${result.from} → ${result.to}`);

      if (result.stashExists) {
        console.log(`\n注意: 您的本地修改已保存到 git stash`);
        console.log(`  查看: cd ~/.claude/skills/${component} && git stash show`);
        console.log(`  恢复: cd ~/.claude/skills/${component} && git stash pop`);
      }
    } else {
      // Print failed steps
      for (const step of result.steps) {
        const icon = step.status === 'done' ? '✓' :
                     step.status === 'skipped' ? '○' : '✗';
        console.log(`  [${step.step}/9] ${step.name} ${icon}`);
        if (step.status === 'failed' && step.error) {
          console.log(`       ${step.error}`);
        }
      }

      console.log(`\n✗ 升级失败 (步骤 ${result.failedStep}): ${result.error}`);

      if (result.rollback?.performed) {
        console.log(`\n⚠️  已自动回滚:`);
        for (const r of result.rollback.steps) {
          const icon = r.success ? '✓' : '✗';
          console.log(`  ${icon} ${r.action}`);
        }
      }

      process.exit(1);
    }
  }
}

/**
 * Handle interactive mode (default)
 */
async function handleInteractive(component, { jsonOutput }) {
  // Check for updates first
  const check = checkForUpdates(component);

  if (!check.success) {
    if (jsonOutput) {
      console.log(JSON.stringify({ action: 'check', component, ...check }, null, 2));
    } else {
      console.error(`Error: ${check.message}`);
    }
    process.exit(1);
  }

  if (!check.hasUpdate) {
    if (jsonOutput) {
      console.log(JSON.stringify({ action: 'check', component, ...check }, null, 2));
    } else {
      console.log(`✓ ${component} is up to date (v${check.current})`);
    }
    return;
  }

  // Show update info
  console.log(`\n${component}: ${check.current} → ${check.latest}`);

  if (check.localChanges) {
    console.log(`\n⚠️  LOCAL MODIFICATIONS DETECTED:`);
    check.localChanges.forEach(c => console.log(`  ${c}`));
  }

  if (check.changelog) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log('CHANGELOG');
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(check.changelog);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  }

  // Interactive confirmation
  const confirmed = await promptConfirm('Proceed with upgrade? [y/N]: ');

  if (!confirmed) {
    console.log('Upgrade cancelled.');
    return;
  }

  // Execute upgrade
  return handleExecuteUpgrade(component, { jsonOutput });
}

/**
 * Handle --all: upgrade all components
 */
async function upgradeAllComponents({ checkOnly, jsonOutput, skipConfirm }) {
  const components = loadComponents();
  const names = Object.keys(components);

  if (names.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ action: 'check_all', components: [], message: 'No components installed' }));
    } else {
      console.log('No components installed.');
    }
    return;
  }

  const results = [];

  for (const name of names) {
    if (!jsonOutput) {
      console.log(`\nChecking ${name}...`);
    }

    const check = checkForUpdates(name);
    results.push({ component: name, ...check });

    if (!jsonOutput && check.success && check.hasUpdate) {
      console.log(`  ${check.current} → ${check.latest}`);
    }
  }

  const updatable = results.filter(r => r.success && r.hasUpdate);

  if (jsonOutput) {
    console.log(JSON.stringify({
      action: checkOnly ? 'check_all' : 'upgrade_all',
      total: names.length,
      updatable: updatable.length,
      components: results,
    }, null, 2));
    return;
  }

  if (updatable.length === 0) {
    console.log('\n✓ All components are up to date.');
    return;
  }

  console.log(`\n${updatable.length} component(s) have updates available.`);

  if (checkOnly) {
    console.log('Run "zylos upgrade --all --yes" to upgrade all.');
    return;
  }

  if (!skipConfirm) {
    console.log('Run "zylos upgrade --all --yes" to upgrade all.');
    return;
  }

  // Execute upgrades
  for (const comp of updatable) {
    console.log(`\nUpgrading ${comp.component}...`);
    const result = runUpgrade(comp.component);
    if (result.success) {
      console.log(`  ✓ ${result.from} → ${result.to}`);
    } else {
      console.log(`  ✗ Failed: ${result.error}`);
    }
  }
}

/**
 * Upgrade zylos-core itself
 */
async function upgradeSelfCore() {
  // zylos-core root is parent of cli/ directory
  // __dirname is cli/commands/, so go up twice to get zylos-core root
  const coreDir = path.join(__dirname, '..', '..');

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
  const purge = args.includes('--purge');
  // Filter out flags to get the target name
  const target = args.find(arg => !arg.startsWith('--'));

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
