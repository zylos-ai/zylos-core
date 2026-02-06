/**
 * Component management commands
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILLS_DIR, COMPONENTS_DIR } from '../lib/config.js';
import { loadRegistry } from '../lib/registry.js';
import { loadComponents, saveComponents } from '../lib/components.js';
import { checkForUpdates, runUpgrade, downloadToTemp, readChangelog, cleanupTemp } from '../lib/upgrade.js';
import {
  checkForCoreUpdates, runSelfUpgrade,
  downloadCoreToTemp, readChangelog as readCoreChangelog,
  cleanupTemp as cleanupCoreTemp, cleanupBackup,
} from '../lib/self-upgrade.js';
import { detectChanges } from '../lib/manifest.js';
import { parseSkillMd } from '../lib/skill.js';
import { acquireLock, releaseLock } from '../lib/lock.js';
import { promptYesNo } from '../lib/prompts.js';
import { evaluateUpgrade } from '../lib/claude-eval.js';

export async function upgradeComponent(args) {
  // Parse flags
  const checkOnly = args.includes('--check');
  const jsonOutput = args.includes('--json');
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const explicitConfirm = args.includes('confirm');
  const upgradeSelf = args.includes('--self');
  const upgradeAll = args.includes('--all');
  const skipEval = args.includes('--skip-eval');

  // Get target component (filter out flags)
  const target = args.find(a => !a.startsWith('-') && a !== 'confirm');

  // Handle --self: upgrade zylos-core itself
  if (upgradeSelf) {
    const ok = await upgradeSelfCore();
    if (!ok) process.exit(1);
    return;
  }

  // Handle --all: upgrade all components
  if (upgradeAll) {
    return upgradeAllComponents({ checkOnly, jsonOutput, skipConfirm, skipEval });
  }

  // Validate target
  if (!target) {
    console.error('Usage: zylos upgrade <name> [options]');
    console.error('       zylos upgrade --all');
    console.error('       zylos upgrade --self');
    console.log('\nOptions:');
    console.log('  --check      Check for updates only');
    console.log('  --json       Output in JSON format');
    console.log('  --yes, -y    Skip confirmation');
    console.log('  --skip-eval  Skip Claude evaluation of local changes');
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
  const ok = await handleUpgradeFlow(target, { jsonOutput, skipConfirm: skipConfirm || explicitConfirm, skipEval });
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
async function handleUpgradeFlow(component, { jsonOutput, skipConfirm, skipEval }) {
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

    // 4. Show info: version diff, changelog, local changes + Claude eval
    const changes = detectChanges(skillDir);
    const changelog = readChangelog(tempDir);
    let evalResult = null;

    if (!jsonOutput) {
      console.log(`\n${component}: ${check.current} → ${check.latest}`);

      // Show local modifications (compared to manifest)
      if (changes && (changes.modified.length > 0 || changes.added.length > 0)) {
        console.log(`\nWARNING: LOCAL MODIFICATIONS DETECTED:`);
        for (const f of changes.modified) console.log(`  M ${f}`);
        for (const f of changes.added) console.log(`  A ${f}`);
      }

      // Show changelog from downloaded version
      if (changelog) {
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log('CHANGELOG');
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(changelog);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      }
    }

    // Claude evaluation (when local changes exist and not skipped)
    if (changes && (changes.modified.length > 0 || changes.added.length > 0) && !skipEval) {
      if (!jsonOutput) {
        console.log('\n⚠️  Evaluating local modifications...');
      }

      evalResult = await evaluateUpgrade({
        component,
        localChanges: changes,
        tempDir,
        skillDir,
        changelog,
      });

      if (evalResult) {
        if (!jsonOutput) {
          console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('Claude Code evaluation:');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          for (const f of evalResult.files) {
            const icon = f.verdict === 'safe' ? '✓' : f.verdict === 'warning' ? '⚠️' : '✗';
            console.log(`${f.file}:\n  ${icon} ${f.reason}\n`);
          }
          console.log(`\nRecommendation: ${evalResult.recommendation}`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }
      } else if (!jsonOutput) {
        console.log('  (Claude evaluation skipped)');
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
      const output = { ...result };
      if (evalResult) output.evaluation = evalResult;
      console.log(JSON.stringify(output, null, 2));
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
async function upgradeAllComponents({ checkOnly, jsonOutput, skipConfirm, skipEval }) {
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
    const ok = await handleUpgradeFlow(comp.component, { jsonOutput, skipConfirm: true, skipEval });
    if (!ok) anyFailed = true;
  }

  if (anyFailed) process.exit(1);
}

/**
 * Upgrade zylos-core itself.
 * Lock-first pattern, same as component upgrades.
 *
 * Returns true on success, false on failure.
 * Does NOT call process.exit() — caller decides exit behavior.
 */
async function upgradeSelfCore() {
  const jsonOutput = process.argv.includes('--json');
  const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');
  let tempDir = null;

  // 1. Acquire lock (reuse component lock mechanism with special name)
  const lockResult = acquireLock('_zylos-core');
  if (!lockResult.success) {
    if (jsonOutput) {
      console.log(JSON.stringify({ action: 'self_upgrade', success: false, error: lockResult.error }, null, 2));
    } else {
      console.error(`Error: ${lockResult.error}`);
    }
    return false;
  }

  try {
    // 2. Check for updates
    const check = checkForCoreUpdates();

    if (!check.success) {
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'check', target: 'zylos-core', ...check }, null, 2));
      } else {
        console.error(`Error: ${check.message}`);
      }
      return false;
    }

    if (!check.hasUpdate) {
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'check', target: 'zylos-core', ...check }, null, 2));
      } else {
        console.log(`✓ zylos-core is up to date (v${check.current})`);
      }
      return true;
    }

    // 3. Download new version to temp
    if (!jsonOutput) {
      console.log(`\nDownloading zylos-core@${check.latest}...`);
    }

    const dlResult = downloadCoreToTemp(check.latest);
    if (!dlResult.success) {
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'self_upgrade', success: false, error: dlResult.error }, null, 2));
      } else {
        console.error(`Error: ${dlResult.error}`);
      }
      return false;
    }
    tempDir = dlResult.tempDir;

    // 4. Show info
    if (!jsonOutput) {
      console.log(`\nzylos-core: ${check.current} → ${check.latest}`);

      const changelog = readCoreChangelog(tempDir);
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
      const confirmed = await promptYesNo('Proceed with zylos-core upgrade? [y/N]: ');
      if (!confirmed) {
        console.log('Upgrade cancelled.');
        return true; // Not an error — user chose to cancel
      }
    } else if (!jsonOutput) {
      console.log('Upgrading zylos-core...');
    }

    // 6. Execute self-upgrade (8 steps)
    const result = runSelfUpgrade({ tempDir, newVersion: check.latest });

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
      console.log(`\n✓ zylos-core upgraded: ${result.from} → ${result.to}`);

      // Clean backup after successful upgrade
      if (result.backupDir) {
        cleanupBackup(result.backupDir);
      }
    } else {
      for (const step of result.steps) {
        const icon = step.status === 'done' ? '✓' :
                     step.status === 'skipped' ? '○' : '✗';
        console.log(`  [${step.step}/8] ${step.name} ${icon}`);
        if (step.status === 'failed' && step.error) {
          console.log(`       ${step.error}`);
        }
      }

      console.log(`\n✗ Self-upgrade failed (step ${result.failedStep}): ${result.error}`);

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
    cleanupCoreTemp(tempDir);
    releaseLock('_zylos-core');
  }
}

export async function uninstallComponent(args) {
  const purge = args.includes('--purge');
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const force = args.includes('--force');
  const target = args.find(arg => !arg.startsWith('-'));

  if (!target) {
    console.error('Usage: zylos uninstall <name> [options]');
    console.log('\nOptions:');
    console.log('  --purge    Also remove data directory (skips prompt)');
    console.log('  --force    Remove even if other components depend on it');
    console.log('  --yes, -y  Skip confirmation (keeps data)');
    process.exit(1);
  }

  const ok = await handleRemoveFlow(target, { purge, skipConfirm, force });
  if (!ok) process.exit(1);
}

/**
 * Find components that depend on the given target.
 */
function findDependents(target) {
  const components = loadComponents();
  const dependents = [];
  for (const name of Object.keys(components)) {
    if (name === target) continue;
    const skillDir = path.join(SKILLS_DIR, name);
    const skill = parseSkillMd(skillDir);
    const deps = skill?.frontmatter?.dependencies || [];
    if (deps.includes(target)) dependents.push(name);
  }
  return dependents;
}

/**
 * Resolve PM2 service name from SKILL.md or fallback to zylos-<name>.
 */
function resolveServiceName(name) {
  const skillDir = path.join(SKILLS_DIR, name);
  const skill = parseSkillMd(skillDir);
  return skill?.frontmatter?.lifecycle?.service?.name || `zylos-${name}`;
}

/**
 * Remove flow: dependency check → confirm → stop PM2 → delete dirs → update components.json.
 * Returns true on success, false on failure.
 */
async function handleRemoveFlow(target, { purge, skipConfirm, force }) {
  const components = loadComponents();

  if (!components[target]) {
    console.error(`Error: Component "${target}" is not installed.`);
    return false;
  }

  const skillDir = path.join(SKILLS_DIR, target);
  const dataDir = path.join(COMPONENTS_DIR, target);

  // Check dependencies
  const dependents = findDependents(target);
  if (dependents.length > 0) {
    if (!force) {
      console.error(`Error: Cannot remove "${target}" — the following components depend on it:`);
      for (const d of dependents) console.error(`  - ${d}`);
      console.error(`\nUse --force to remove anyway.`);
      return false;
    }
    console.log(`Warning: The following components depend on "${target}":`);
    for (const d of dependents) console.log(`  - ${d}`);
    console.log('');
  }

  // Show what will be removed
  const serviceName = resolveServiceName(target);
  console.log(`Will remove "${target}":`);
  console.log(`  Service:   ${serviceName} (pm2)`);
  console.log(`  Skill dir: ${skillDir}`);
  if (purge) {
    console.log(`  Data dir:  ${dataDir} (--purge)`);
  } else {
    console.log(`  Data dir:  ${dataDir} (kept)`);
  }

  // Confirmation
  if (!skipConfirm) {
    const confirmed = await promptYesNo('\nProceed? [y/N]: ');
    if (!confirmed) {
      console.log('Cancelled.');
      return true; // not an error
    }

    // Ask about data directory if --purge not explicitly set
    if (!purge && fs.existsSync(dataDir)) {
      purge = await promptYesNo('Also remove data directory? [y/N]: ');
    }
  }

  // 1. Stop + delete PM2 service (use execFileSync to avoid shell injection)
  try {
    try { execFileSync('pm2', ['stop', serviceName], { stdio: 'pipe' }); } catch { /* ignore */ }
    execFileSync('pm2', ['delete', serviceName], { stdio: 'pipe' });
    console.log(`  ✓ PM2 service "${serviceName}" removed`);
  } catch {
    console.log(`  ○ PM2 service "${serviceName}" not found (skipped)`);
  }

  // 2. Remove skill directory
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    console.log(`  ✓ Skill directory removed`);
  } else {
    console.log(`  ○ Skill directory not found (skipped)`);
  }

  // 3. Remove data directory if --purge
  if (purge) {
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.log(`  ✓ Data directory removed`);
    } else {
      console.log(`  ○ Data directory not found (skipped)`);
    }
  }

  // 4. Update components.json
  delete components[target];
  saveComponents(components);
  console.log(`  ✓ Removed from components.json`);

  console.log(`\n✓ ${target} uninstalled.`);
  return true;
}

/**
 * Show detailed information about a component.
 */
export async function infoComponent(args) {
  const jsonOutput = args.includes('--json');
  const target = args.find(arg => !arg.startsWith('-'));

  if (!target) {
    console.error('Usage: zylos info <name> [--json]');
    process.exit(1);
  }

  const components = loadComponents();
  if (!components[target]) {
    console.error(`Error: Component "${target}" is not installed.`);
    process.exit(1);
  }

  const comp = components[target];
  const skillDir = path.join(SKILLS_DIR, target);
  const dataDir = path.join(COMPONENTS_DIR, target);

  // Parse SKILL.md
  const skill = parseSkillMd(skillDir);
  const fm = skill?.frontmatter || {};
  const description = fm.description || '';
  const deps = fm.dependencies || [];
  const serviceName = fm.lifecycle?.service?.name || `zylos-${target}`;

  // PM2 status
  let pm2Status = null;
  try {
    const pm2Json = execFileSync('pm2', ['jlist'], { encoding: 'utf8' });
    const processes = JSON.parse(pm2Json);
    const proc = processes.find(p => p.name === serviceName);
    if (proc) {
      pm2Status = {
        status: proc.pm2_env?.status || 'unknown',
        pid: proc.pid,
        uptime: proc.pm2_env?.pm_uptime || null,
      };
    }
  } catch {
    // pm2 not available or no processes
  }

  // Local changes
  const changes = detectChanges(skillDir);

  if (jsonOutput) {
    const info = {
      name: target,
      version: comp.version,
      description,
      type: comp.type || 'unknown',
      repo: comp.repo,
      installedAt: comp.installedAt || null,
      upgradedAt: comp.upgradedAt || null,
      service: { name: serviceName, ...pm2Status },
      skillDir,
      dataDir,
      dependencies: deps,
      changes: changes ? {
        modified: changes.modified.length,
        added: changes.added.length,
        deleted: changes.deleted.length,
      } : null,
    };
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  // Human-readable output
  const skillExists = fs.existsSync(skillDir);
  const icon = skillExists ? '✓' : '✗';
  console.log(`\n${target} (v${comp.version}) ${icon}\n`);

  if (description) console.log(`  Description:  ${description}`);
  console.log(`  Type:         ${comp.type || 'unknown'}`);
  console.log(`  Repo:         ${comp.repo}`);
  if (comp.installedAt) console.log(`  Installed:    ${comp.installedAt}`);
  if (comp.upgradedAt) console.log(`  Upgraded:     ${comp.upgradedAt}`);

  // Service info
  console.log('');
  if (pm2Status) {
    let uptimeStr = '';
    if (pm2Status.uptime) {
      const ms = Date.now() - pm2Status.uptime;
      const days = Math.floor(ms / 86400000);
      const hours = Math.floor((ms % 86400000) / 3600000);
      if (days > 0) uptimeStr = `, uptime ${days}d${hours}h`;
      else if (hours > 0) uptimeStr = `, uptime ${hours}h`;
    }
    console.log(`  Service:      ${serviceName} (pm2)`);
    console.log(`  Status:       ${pm2Status.status} (pid ${pm2Status.pid}${uptimeStr})`);
  } else {
    console.log(`  Service:      ${serviceName} (pm2)`);
    console.log(`  Status:       not running`);
  }

  // Directories
  console.log('');
  console.log(`  Skill Dir:    ${skillDir}`);
  console.log(`  Data Dir:     ${dataDir}`);

  // Dependencies
  if (deps.length > 0) {
    console.log('');
    console.log(`  Dependencies: ${deps.join(', ')}`);
  }

  // Local changes
  if (changes) {
    const total = changes.modified.length + changes.added.length + changes.deleted.length;
    if (total > 0) {
      const parts = [];
      if (changes.modified.length) parts.push(`${changes.modified.length} modified`);
      if (changes.added.length) parts.push(`${changes.added.length} added`);
      if (changes.deleted.length) parts.push(`${changes.deleted.length} deleted`);
      console.log(`  Local Changes: ${parts.join(', ')}`);
    }
  }

  console.log('');
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
