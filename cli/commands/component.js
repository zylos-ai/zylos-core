/**
 * Component management commands
 */

import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_DIR, SKILLS_DIR, COMPONENTS_DIR } from '../lib/config.js';
import { loadRegistry } from '../lib/registry.js';
import { loadComponents, saveComponents, outputTask } from '../lib/components.js';
import { checkForUpdates, runUpgrade, downloadToTemp, readChangelog, cleanupTemp } from '../lib/upgrade.js';
import { detectChanges } from '../lib/manifest.js';
import { acquireLock, releaseLock } from '../lib/lock.js';
import { promptYesNo } from '../lib/prompts.js';

export async function upgradeComponent(args) {
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
    console.error('       zylos upgrade --all');
    console.error('       zylos upgrade --self');
    console.log('\nOptions:');
    console.log('  --check    Check for updates only');
    console.log('  --json     Output in JSON format');
    console.log('  --yes, -y  Skip confirmation');
    console.log('\nExamples:');
    console.log('  zylos upgrade telegram --check --json');
    console.log('  zylos upgrade telegram --yes');
    console.log('  zylos upgrade telegram');
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
      message: `Component '${target}' is not registered in components.json`,
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
      message: `Component directory not found: ${skillDir}`,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.message}`);
    }
    process.exit(1);
  }

  // Mode 1: Check only (--check) — no lock, no download needed
  if (checkOnly) {
    return handleCheckOnly(target, { jsonOutput });
  }

  // Mode 2 & 3: Full upgrade flow (lock-first)
  const ok = await handleUpgradeFlow(target, { jsonOutput, skipConfirm: skipConfirm || explicitConfirm });
  if (!ok) process.exit(1);
}

/**
 * Handle --check flag: check for updates only (no lock needed)
 */
async function handleCheckOnly(component, { jsonOutput }) {
  const result = checkForUpdates(component);

  if (jsonOutput) {
    console.log(JSON.stringify({ action: 'check', component, ...result }, null, 2));
    if (!result.success) process.exit(1);
  } else {
    if (!result.success) {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }

    if (!result.hasUpdate) {
      console.log(`✓ ${component} is up to date (v${result.current})`);
    } else {
      console.log(`${component}: ${result.current} → ${result.latest}`);
      console.log(`\nRun "zylos upgrade ${component} --yes" to upgrade.`);
    }
  }
}

/**
 * Full upgrade flow with lock-first pattern.
 * Lock wraps the entire operation: check → download → confirm → execute → cleanup.
 *
 * Returns true on success, false on failure.
 * Does NOT call process.exit() — caller decides exit behavior.
 */
async function handleUpgradeFlow(component, { jsonOutput, skipConfirm }) {
  const skillDir = path.join(SKILLS_DIR, component);
  let tempDir = null;

  // 1. Acquire lock
  const lockResult = acquireLock(component);
  if (!lockResult.success) {
    if (jsonOutput) {
      console.log(JSON.stringify({ action: 'upgrade', component, success: false, error: lockResult.error }, null, 2));
    } else {
      console.error(`Error: ${lockResult.error}`);
    }
    return false;
  }

  try {
    // 2. Check for updates
    const check = checkForUpdates(component);

    if (!check.success) {
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'check', component, ...check }, null, 2));
      } else {
        console.error(`Error: ${check.message}`);
      }
      return false;
    }

    if (!check.hasUpdate) {
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'check', component, ...check }, null, 2));
      } else {
        console.log(`✓ ${component} is up to date (v${check.current})`);
      }
      return true;
    }

    // 3. Download new version to temp
    if (!check.repo) {
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'upgrade', component, success: false, error: 'No repo configured' }, null, 2));
      } else {
        console.error('Error: No repo configured for this component');
      }
      return false;
    }

    if (!jsonOutput) {
      console.log(`\nDownloading ${component}@${check.latest}...`);
    }

    const dlResult = downloadToTemp(check.repo, check.latest);
    if (!dlResult.success) {
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'upgrade', component, success: false, error: dlResult.error }, null, 2));
      } else {
        console.error(`Error: ${dlResult.error}`);
      }
      return false;
    }
    tempDir = dlResult.tempDir;

    // 4. Show info: version diff, changelog, local changes
    if (!jsonOutput) {
      console.log(`\n${component}: ${check.current} → ${check.latest}`);

      // Show local modifications (compared to manifest)
      const changes = detectChanges(skillDir);
      if (changes && (changes.modified.length > 0 || changes.added.length > 0)) {
        console.log(`\nWARNING: LOCAL MODIFICATIONS DETECTED:`);
        for (const f of changes.modified) console.log(`  M ${f}`);
        for (const f of changes.added) console.log(`  A ${f}`);
      }

      // Show changelog from downloaded version
      const changelog = readChangelog(tempDir);
      if (changelog) {
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log('CHANGELOG');
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(changelog);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      }
    }

    // 5. Confirmation
    if (!skipConfirm) {
      const confirmed = await promptYesNo('Proceed with upgrade? [y/N]: ');
      if (!confirmed) {
        console.log('Upgrade cancelled.');
        return true; // Not an error — user chose to cancel
      }
    } else if (!jsonOutput) {
      console.log(`Upgrading ${component}...`);
    }

    // 6. Execute upgrade (8 steps)
    const result = runUpgrade(component, { tempDir, newVersion: check.latest });

    if (result.success) {
      // Phase C: Cleanup
      // Update components.json
      const components = loadComponents();
      if (components[component]) {
        components[component].version = result.to || components[component].version;
        components[component].upgradedAt = new Date().toISOString();
        saveComponents(components);
      }

      // Clean old backups (keep only the latest)
      cleanOldBackups(skillDir);
    }

    // Output result
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.success) {
      for (const step of result.steps) {
        const icon = step.status === 'done' ? '✓' :
                     step.status === 'skipped' ? '○' : '✗';
        const msg = step.message ? ` (${step.message})` : '';
        console.log(`  [${step.step}/8] ${step.name}${msg} ${icon}`);
      }
      console.log(`\n✓ ${component} upgraded: ${result.from} → ${result.to}`);
    } else {
      for (const step of result.steps) {
        const icon = step.status === 'done' ? '✓' :
                     step.status === 'skipped' ? '○' : '✗';
        console.log(`  [${step.step}/8] ${step.name} ${icon}`);
        if (step.status === 'failed' && step.error) {
          console.log(`       ${step.error}`);
        }
      }

      console.log(`\n✗ Upgrade failed (step ${result.failedStep}): ${result.error}`);

      if (result.rollback?.performed) {
        console.log(`\nAuto-rollback performed:`);
        for (const r of result.rollback.steps) {
          const icon = r.success ? '✓' : '✗';
          console.log(`  ${icon} ${r.action}`);
        }
      }
    }

    return result.success;
  } finally {
    // Always: cleanup temp + release lock
    cleanupTemp(tempDir);
    releaseLock(component);
  }
}

/**
 * Clean old .backup/ directories, keeping only the latest.
 */
function cleanOldBackups(skillDir) {
  const backupRoot = path.join(skillDir, '.backup');
  if (!fs.existsSync(backupRoot)) return;

  try {
    const entries = fs.readdirSync(backupRoot).sort();
    // Keep the last one, remove the rest
    for (let i = 0; i < entries.length - 1; i++) {
      fs.rmSync(path.join(backupRoot, entries[i]), { recursive: true, force: true });
    }
  } catch {
    // Non-critical, ignore
  }
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

  // Check all components first
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
    const confirmed = await promptYesNo('Upgrade all components? [y/N]: ');
    if (!confirmed) {
      console.log('Upgrade cancelled.');
      return;
    }
  }

  // Execute upgrades (lock per component via handleUpgradeFlow)
  let anyFailed = false;
  for (const comp of updatable) {
    if (!jsonOutput) {
      console.log(`\n─── ${comp.component} ───`);
    }
    const ok = await handleUpgradeFlow(comp.component, { jsonOutput, skipConfirm: true });
    if (!ok) anyFailed = true;
  }

  if (anyFailed) process.exit(1);
}

/**
 * Upgrade zylos-core itself
 */
async function upgradeSelfCore() {
  console.log('Checking for zylos-core updates...');

  outputTask('self_upgrade', {
    target: 'zylos-core',
    repo: 'zylos-ai/zylos-core',
    coreDir: path.join(import.meta.dirname, '..', '..'),
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

export async function uninstallComponent(args) {
  const purge = args.includes('--purge');
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

export async function listComponents() {
  const components = loadComponents();
  const names = Object.keys(components);

  if (names.length === 0) {
    console.log('No components installed.');
    console.log('\nUse "zylos search <keyword>" to find available components.');
    console.log('Use "zylos add <name>" to install a component.');
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

export async function searchComponents(args) {
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
      console.log(`  zylos add <github-url>`);
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
  console.log('\nUse "zylos add <name>" to install a component.');
}
