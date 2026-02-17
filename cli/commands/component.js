/**
 * Component management commands
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILLS_DIR, COMPONENTS_DIR } from '../lib/config.js';
import { bold, dim, green, red, yellow, cyan, success, error, warn, heading } from '../lib/colors.js';
import { loadRegistry } from '../lib/registry.js';
import { loadComponents, saveComponents } from '../lib/components.js';
import { checkForUpdates, getRepo, runUpgrade, downloadToTemp, readChangelog, filterChangelog, cleanupTemp } from '../lib/upgrade.js';
import {
  checkForCoreUpdates, runSelfUpgrade,
  downloadCoreToTemp, readChangelog as readCoreChangelog,
  cleanupTemp as cleanupCoreTemp, cleanupBackup,
} from '../lib/self-upgrade.js';
import { detectChanges } from '../lib/manifest.js';
import { parseSkillMd } from '../lib/skill.js';
import { linkBins, unlinkBins } from '../lib/bin.js';
import { removeCaddyRoutes } from '../lib/caddy.js';
import { acquireLock, releaseLock } from '../lib/lock.js';
import { fetchRawFile } from '../lib/github.js';
import { promptYesNo } from '../lib/prompts.js';
import { evaluateUpgrade } from '../lib/claude-eval.js';

/**
 * Print a single upgrade step result in real time.
 * Each step result includes { step, total, name, status, message?, error? }.
 */
function printStep(step) {
  const msg = step.message ? ` (${step.message})` : '';
  const label = `[${step.step}/${step.total}] ${step.name}${msg}`;
  if (step.status === 'done') {
    console.log(`  ${success(label)}`);
  } else if (step.status === 'skipped') {
    console.log(`  ${dim('○')} ${dim(label)}`);
  } else {
    console.log(`  ${error(label)}`);
  }
  if (step.status === 'failed' && step.error) {
    console.log(`       ${red(step.error)}`);
  }
}

/**
 * Generate a pre-formatted C4 (IM channel) reply from command output.
 * Claude can use this reply directly, independent of SKILL.md version.
 */
function formatC4Reply(type, data) {
  switch (type) {
    case 'check': {
      const { component, hasUpdate, current, latest, changelog, localChanges, evaluation } = data;
      if (!hasUpdate) return `${component} is up to date (v${current})`;
      let r = `${component}: ${current} -> ${latest}`;
      if (changelog) r += `\n\nChangelog:\n${changelog}`;
      if (localChanges) {
        r += '\n\nLocal changes:';
        if (localChanges.modified) for (const f of localChanges.modified) r += `\n  M ${f}`;
        if (localChanges.added) for (const f of localChanges.added) r += `\n  A ${f}`;
      }
      if (evaluation) {
        r += '\n\nUpgrade analysis:';
        for (const f of evaluation.files || []) {
          r += `\n  ${f.file}: ${f.verdict} - ${f.reason}`;
        }
        r += `\nRecommendation: ${evaluation.recommendation}`;
      }
      r += `\n\nReply "upgrade ${component} confirm" to proceed.`;
      return r;
    }
    case 'self-check': {
      const { hasUpdate, current, latest, changelog, localChanges } = data;
      if (!hasUpdate) return `zylos-core is up to date (v${current})`;
      let r = `zylos-core: ${current} -> ${latest}`;
      if (changelog) r += `\n\nChangelog:\n${changelog}`;
      if (localChanges && localChanges.length > 0) {
        r += '\n\nLocal skill modifications:';
        for (const { skill, modified, added } of localChanges) {
          for (const f of modified) r += `\n  M ${skill}/${f}`;
          for (const f of added) r += `\n  A ${skill}/${f}`;
        }
      }
      r += '\n\nReply "upgrade zylos confirm" to proceed.';
      return r;
    }
    case 'upgrade': {
      const { component, success, from, to, changelog, failedStep, error, rollback } = data;
      if (!success) {
        let r = `${component} upgrade failed (step ${failedStep}): ${error}`;
        if (rollback?.performed) {
          r += '\nRollback: ' + rollback.steps.map(s => `${s.success ? 'OK' : 'FAIL'}: ${s.action}`).join(', ');
        }
        return r;
      }
      let r = `${component} upgraded: ${from} -> ${to}`;
      if (changelog) r += `\n\nChangelog:\n${changelog}`;
      return r;
    }
    case 'self-upgrade': {
      const { success, from, to, changelog, failedStep, error, rollback, migrationHints } = data;
      if (!success) {
        let r = `zylos-core upgrade failed (step ${failedStep}): ${error}`;
        if (rollback?.performed) {
          r += '\nRollback: ' + rollback.steps.map(s => `${s.success ? 'OK' : 'FAIL'}: ${s.action}`).join(', ');
        }
        return r;
      }
      let r = `zylos-core upgraded: ${from} -> ${to}`;
      if (changelog) r += `\n\nChangelog:\n${changelog}`;
      if (migrationHints?.length > 0) {
        r += '\n\nACTION REQUIRED - Hook changes in ~/zylos/.claude/settings.json:';
        for (const hint of migrationHints) {
          if (hint.type === 'missing_hook') {
            r += `\n  [${hint.event}] ADD: ${hint.command} (timeout: ${hint.timeout}ms)`;
          } else if (hint.type === 'modified_hook') {
            r += `\n  [${hint.event}] UPDATE: ${hint.command} (timeout: ${hint.timeout}ms)`;
          } else if (hint.type === 'removed_hook') {
            r += `\n  [${hint.event}] REMOVE: ${hint.command}`;
          }
        }
        r += '\nPlease update hooks in ~/zylos/.claude/settings.json and restart Claude to apply.';
      }
      return r;
    }
    case 'check-all': {
      const { total, updatable, components } = data;
      if (updatable === 0) return 'All components are up to date.';
      let r = `${updatable} of ${total} component(s) have updates:`;
      for (const c of components) {
        if (c.hasUpdate) r += `\n  ${c.component}: ${c.current} -> ${c.latest}`;
      }
      r += '\n\nUse "check <name>" to see details, or "upgrade <name>" to preview.';
      return r;
    }
    case 'info': {
      const { name, version, description, type: compType, repo, service } = data;
      let r = `${name} v${version}`;
      if (description) r += `\n${description}`;
      r += `\nType: ${compType || 'unknown'}`;
      r += `\nRepo: ${repo}`;
      if (service) {
        const status = service.status || 'not running';
        r += `\nService: ${service.name} (${status})`;
      }
      return r;
    }
    case 'uninstall-check': {
      const { component, version, service, dependents, dataDir } = data;
      let r = `Uninstall ${component} (v${version})?`;
      r += `\n\nThe ${component} service will be stopped and removed.`;
      r += `\nYour data (config, logs) in ${dataDir} can be preserved.`;
      if (dependents && dependents.length > 0) {
        r += `\n\nCannot uninstall: these components depend on ${component}:`;
        for (const d of dependents) r += `\n  - ${d}`;
        r += `\nRemove them first, or use CLI with --force.`;
        return r;
      }
      r += `\n\nReply:`;
      r += `\n  "uninstall ${component} confirm" - uninstall, keep your data`;
      r += `\n  "uninstall ${component} purge" - uninstall and delete all data`;
      return r;
    }
    case 'uninstall': {
      const { component, success, steps, error } = data;
      if (!success) return `${component} uninstall failed: ${error}`;
      let r = `${component} uninstalled.`;
      if (steps) {
        for (const s of steps) {
          const icon = s.success ? 'OK' : 'skipped';
          r += `\n  ${s.action}: ${icon}`;
        }
      }
      return r;
    }
    case 'error':
      return data.message || data.error || 'Unknown error';
    default:
      return null;
  }
}

export async function upgradeComponent(args) {
  // Parse flags
  const checkOnly = args.includes('--check');
  const jsonOutput = args.includes('--json');
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const explicitConfirm = args.includes('confirm');
  const upgradeSelf = args.includes('--self');
  const upgradeAll = args.includes('--all');
  const skipEval = args.includes('--skip-eval');

  // Parse --branch <name> flag
  const branchIndex = args.indexOf('--branch');
  const branch = branchIndex !== -1 ? args[branchIndex + 1] : null;
  if (branchIndex !== -1 && (!branch || branch.startsWith('-'))) {
    console.error('Error: --branch requires a branch name.');
    process.exit(1);
  }

  // Get target component (filter out flags and flag values)
  const flagsWithValues = new Set(['--temp-dir', '--branch']);
  const target = args.find((a, i) => {
    if (a.startsWith('-')) return false;
    if (a === 'confirm') return false;
    // Skip values that follow flags with arguments
    if (i > 0 && flagsWithValues.has(args[i - 1])) return false;
    return true;
  });

  // Handle --self: upgrade zylos-core itself
  if (upgradeSelf) {
    if (checkOnly) {
      return handleSelfCheckOnly({ jsonOutput });
    }
    // Parse --temp-dir flag (reuse previously downloaded package from --check)
    const selfTempDirIdx = args.indexOf('--temp-dir');
    const selfProvidedTempDir = selfTempDirIdx !== -1 ? args[selfTempDirIdx + 1] : null;
    const ok = await upgradeSelfCore({ providedTempDir: selfProvidedTempDir, branch });
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
    console.log('  --check        Check for updates only (downloads to temp for comparison)');
    console.log('  --json         Output in JSON format');
    console.log('  --yes, -y      Skip confirmation');
    console.log('  --skip-eval    Skip upgrade analysis of local changes');
    console.log('  --branch <b>   Upgrade from a specific branch (e.g. feat/xxx)');
    console.log('  --temp-dir <d> Reuse previously downloaded package from --check');
    console.log('\nExamples:');
    console.log('  zylos upgrade telegram --check --json');
    console.log('  zylos upgrade telegram --yes --temp-dir /tmp/zylos-xxx');
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
      reply: `Component '${target}' is not installed.`,
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
      reply: `Component '${target}' directory not found.`,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.message}`);
    }
    process.exit(1);
  }

  // Parse --temp-dir flag (reuse previously downloaded package)
  const tempDirIdx = args.indexOf('--temp-dir');
  const providedTempDir = tempDirIdx !== -1 ? args[tempDirIdx + 1] : null;

  // Mode 1: Check only (--check) — no lock, downloads to temp for file comparison
  if (checkOnly) {
    return handleCheckOnly(target, { jsonOutput });
  }

  // Mode 2 & 3: Full upgrade flow (lock-first)
  const ok = await handleUpgradeFlow(target, { jsonOutput, skipConfirm: skipConfirm || explicitConfirm, skipEval, providedTempDir, branch });
  if (!ok) process.exit(1);
}

/**
 * Handle --check flag: check for updates only (no lock needed).
 * Also fetches changelog, detects local changes, and runs Claude eval for a complete preview.
 */
async function handleCheckOnly(component, { jsonOutput }) {
  const result = checkForUpdates(component);

  if (!result.success) {
    if (jsonOutput) {
      const errOutput = { action: 'check', component, ...result };
      errOutput.reply = formatC4Reply('error', result);
      console.log(JSON.stringify(errOutput, null, 2));
    } else {
      console.error(`Error: ${result.message}`);
    }
    process.exit(1);
  }

  // Enrich with changelog, local changes, and Claude eval when update is available
  let changelog = null;
  let localChanges = null;
  let evalResult = null;
  let tempDir = null;

  if (result.hasUpdate && result.repo) {
    // Download new version to temp dir (for file comparison by Claude)
    const dlResult = downloadToTemp(result.repo, result.latest);
    if (dlResult.success) {
      tempDir = dlResult.tempDir;

      // Read changelog from downloaded package (more reliable than remote fetch)
      const fullChangelog = readChangelog(tempDir);
      changelog = filterChangelog(fullChangelog, result.current);
    } else {
      // Fallback: fetch changelog from remote
      try {
        const rawChangelog = fetchRawFile(result.repo, 'CHANGELOG.md', `v${result.latest}`);
        changelog = filterChangelog(rawChangelog, result.current);
      } catch {
        // CHANGELOG.md may not exist — that's fine
      }
    }

    // Detect local modifications against manifest
    const skillDir = path.join(SKILLS_DIR, component);
    const changes = detectChanges(skillDir);
    if (changes && (changes.modified.length > 0 || changes.added.length > 0)) {
      localChanges = { modified: changes.modified, added: changes.added };

      // Claude eval for local changes (only when tempDir is available)
      if (tempDir) {
        try {
          evalResult = await evaluateUpgrade({
            component,
            localChanges: changes,
            tempDir,
            skillDir,
            changelog,
          });
        } catch {
          // Eval failure is non-fatal
        }
      }
    }
  }

  if (jsonOutput) {
    const output = { action: 'check', component, ...result };
    if (changelog) output.changelog = changelog;
    if (localChanges) output.localChanges = localChanges;
    if (evalResult) output.evaluation = evalResult;
    if (tempDir) output.tempDir = tempDir;
    output.reply = formatC4Reply('check', { component, ...result, changelog, localChanges, evaluation: evalResult });
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (!result.hasUpdate) {
      console.log(success(`${bold(component)} is up to date (v${result.current})`));
    } else {
      console.log(`${bold(component)}: ${dim(result.current)} → ${bold(result.latest)}`);

      if (localChanges) {
        console.log(`\n${warn('LOCAL MODIFICATIONS DETECTED:')}`);
        for (const f of localChanges.modified) console.log(`  ${yellow('M')} ${f}`);
        for (const f of localChanges.added) console.log(`  ${green('A')} ${f}`);
      }

      if (evalResult) {
        console.log(`\n${heading('Upgrade analysis:')}`);
        for (const f of evalResult.files) {
          if (f.verdict === 'safe') {
            console.log(`  ${success(`${f.file}: ${f.reason}`)}`);
          } else if (f.verdict === 'warning') {
            console.log(`  ${warn(`${f.file}: ${f.reason}`)}`);
          } else {
            console.log(`  ${error(`${f.file}: ${f.reason}`)}`);
          }
        }
        console.log(`\n${bold('Recommendation:')} ${evalResult.recommendation}`);
      }

      if (changelog) {
        console.log(`\n${heading('Changelog:')}\n${changelog}`);
      }

      if (tempDir) {
        console.log(`\n${dim(`Downloaded to: ${tempDir}`)}`);
      }
      console.log(`\n${dim(`Run "zylos upgrade ${component} --yes" to upgrade.`)}`);
    }
  }

  // NOTE: tempDir is NOT cleaned up here — it's kept for reuse by --yes --temp-dir
  // Claude or the user is responsible for cleanup if upgrade is not performed
}

/**
 * Full upgrade flow with lock-first pattern.
 * Lock wraps the entire operation: check → download → confirm → execute → cleanup.
 *
 * Returns true on success, false on failure.
 * Does NOT call process.exit() — caller decides exit behavior.
 */
async function handleUpgradeFlow(component, { jsonOutput, skipConfirm, skipEval, providedTempDir, branch }) {
  const skillDir = path.join(SKILLS_DIR, component);
  let tempDir = providedTempDir || null;
  const tempDirWasProvided = !!providedTempDir;

  // 1. Acquire lock
  const lockResult = acquireLock(component);
  if (!lockResult.success) {
    if (jsonOutput) {
      const errOutput = { action: 'upgrade', component, success: false, error: lockResult.error };
      errOutput.reply = formatC4Reply('error', { message: lockResult.error });
      console.log(JSON.stringify(errOutput, null, 2));
    } else {
      console.error(`Error: ${lockResult.error}`);
    }
    return false;
  }

  try {
    // 2. Check for updates (skip version comparison when --branch is specified)
    const check = checkForUpdates(component);

    if (!check.success) {
      if (!branch) {
        if (jsonOutput) {
          const errOutput = { action: 'check', component, ...check };
          errOutput.reply = formatC4Reply('error', check);
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error(`Error: ${check.message}`);
        }
        return false;
      }
      // When --branch is specified, version check failure is non-fatal
    }

    if (!branch && check.success && !check.hasUpdate) {
      if (jsonOutput) {
        const output = { action: 'check', component, ...check };
        output.reply = formatC4Reply('check', { component, ...check });
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(success(`${bold(component)} is up to date (v${check.current})`));
      }
      return true;
    }

    // 3. Download new version to temp (skip if reusing from --check)
    if (tempDirWasProvided) {
      // Validate provided temp dir exists
      if (!fs.existsSync(tempDir)) {
        const msg = `Provided temp dir does not exist: ${tempDir}`;
        if (jsonOutput) {
          const errOutput = { action: 'upgrade', component, success: false, error: msg };
          errOutput.reply = formatC4Reply('error', { message: msg });
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error(`Error: ${msg}`);
        }
        return false;
      }
      if (!jsonOutput) {
        console.log(`\n${dim(`Reusing previously downloaded package from ${tempDir}`)}`);
      }
    } else {
      const repo = check.repo || (branch ? getRepo(component) : null);
      if (!repo) {
        if (jsonOutput) {
          const errOutput = { action: 'upgrade', component, success: false, error: 'No repo configured' };
          errOutput.reply = formatC4Reply('error', { message: 'No repo configured' });
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error('Error: No repo configured for this component');
        }
        return false;
      }

      const downloadLabel = branch ? `${component} (branch: ${branch})` : `${component}@${check.latest}`;
      if (!jsonOutput) {
        console.log(`\nDownloading ${bold(downloadLabel)}...`);
      }

      const dlResult = downloadToTemp(repo, check.latest, branch);
      if (!dlResult.success) {
        if (jsonOutput) {
          const errOutput = { action: 'upgrade', component, success: false, error: dlResult.error };
          errOutput.reply = formatC4Reply('error', { message: dlResult.error });
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error(`Error: ${dlResult.error}`);
        }
        return false;
      }
      tempDir = dlResult.tempDir;
    }

    // 4. Show info: version diff, changelog, local changes + Claude eval
    const changes = detectChanges(skillDir);
    const fullChangelog = readChangelog(tempDir);
    const changelog = filterChangelog(fullChangelog, check.current);
    let evalResult = null;

    if (!jsonOutput) {
      console.log(`\n${bold(component)}: ${dim(check.current)} → ${bold(check.latest)}`);

      // Show local modifications (compared to manifest)
      if (changes && (changes.modified.length > 0 || changes.added.length > 0)) {
        console.log(`\n${warn('LOCAL MODIFICATIONS DETECTED:')}`);
        for (const f of changes.modified) console.log(`  ${yellow('M')} ${f}`);
        for (const f of changes.added) console.log(`  ${green('A')} ${f}`);
      }

      // Show changelog from downloaded version (filtered to relevant versions only)
      if (changelog) {
        console.log(`\n${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
        console.log(heading('CHANGELOG'));
        console.log(`${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
        console.log(changelog);
        console.log(`${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}\n`);
      }
    }

    // Claude evaluation (when local changes exist and not skipped)
    if (changes && (changes.modified.length > 0 || changes.added.length > 0) && !skipEval) {
      if (!jsonOutput) {
        console.log(`\n${warn('Evaluating local modifications...')}`);
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
          console.log(`\n${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
          console.log(heading('Upgrade analysis:'));
          console.log(`${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
          for (const f of evalResult.files) {
            if (f.verdict === 'safe') {
              console.log(`${bold(f.file)}:\n  ${success(f.reason)}\n`);
            } else if (f.verdict === 'warning') {
              console.log(`${bold(f.file)}:\n  ${warn(f.reason)}\n`);
            } else {
              console.log(`${bold(f.file)}:\n  ${error(f.reason)}\n`);
            }
          }
          console.log(`\n${bold('Recommendation:')} ${evalResult.recommendation}`);
          console.log(`${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
        }
      } else if (!jsonOutput) {
        console.log(`  ${dim('(Upgrade analysis skipped)')}`);
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
      console.log(`Upgrading ${bold(component)}...`);
    }

    // 6. Execute upgrade (5 steps) — show progress in real time
    const result = runUpgrade(component, {
      tempDir,
      newVersion: check.latest,
      onStep: !jsonOutput ? printStep : undefined,
    });

    if (result.success) {
      // Phase C: Cleanup
      // Update components.json
      const components = loadComponents();
      if (components[component]) {
        components[component].version = result.to || components[component].version;
        components[component].upgradedAt = new Date().toISOString();

        // Update bin symlinks (remove old, create new)
        const oldBin = components[component].bin;
        if (oldBin) unlinkBins(oldBin);
        const updatedSkill = parseSkillMd(skillDir);
        const newBin = linkBins(skillDir, updatedSkill?.frontmatter?.bin);
        if (newBin) {
          components[component].bin = newBin;
        } else {
          delete components[component].bin;
        }

        saveComponents(components);
      }

      // Clean old backups (keep only the latest)
      cleanOldBackups(skillDir);
    }

    // Output result
    if (jsonOutput) {
      const output = { ...result };
      if (changelog) output.changelog = changelog;
      if (evalResult) output.evaluation = evalResult;
      output.reply = formatC4Reply('upgrade', { component, ...result, changelog });
      console.log(JSON.stringify(output, null, 2));
    } else if (result.success) {
      console.log(`\n${success(`${bold(component)} upgraded: ${dim(result.from)} → ${bold(result.to)}`)}`);
      if (changelog) {
        console.log(`\n${heading('Changelog:')}\n${changelog}`);
      }
    } else {
      console.log(`\n${error(`Upgrade failed (step ${result.failedStep}): ${result.error}`)}`);

      if (result.rollback?.performed) {
        console.log(`\n${bold('Auto-rollback performed:')}`);
        for (const r of result.rollback.steps) {
          if (r.success) {
            console.log(`  ${success(r.action)}`);
          } else {
            console.log(`  ${error(r.action)}`);
          }
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
      const output = { action: 'check_all', components: [], message: 'No components installed' };
      output.reply = 'No components installed.';
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log('No components installed.');
    }
    return;
  }

  // Check all components first
  const results = [];

  for (const name of names) {
    if (!jsonOutput) {
      console.log(`\nChecking ${bold(name)}...`);
    }

    const check = checkForUpdates(name);
    results.push({ component: name, ...check });

    if (!jsonOutput && check.success && check.hasUpdate) {
      console.log(`  ${dim(check.current)} → ${bold(check.latest)}`);
    }
  }

  const updatable = results.filter(r => r.success && r.hasUpdate);

  if (jsonOutput) {
    const output = {
      action: checkOnly ? 'check_all' : 'upgrade_all',
      total: names.length,
      updatable: updatable.length,
      components: results,
    };
    output.reply = formatC4Reply('check-all', { total: names.length, updatable: updatable.length, components: results });
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (updatable.length === 0) {
    console.log(`\n${success('All components are up to date.')}`);
    return;
  }

  console.log(`\n${bold(`${updatable.length}`)} component(s) have updates available.`);

  if (checkOnly) {
    console.log(dim('Run "zylos upgrade --all --yes" to upgrade all.'));
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
      console.log(`\n${heading(`─── ${comp.component} ───`)}`);
    }
    const ok = await handleUpgradeFlow(comp.component, { jsonOutput, skipConfirm: true, skipEval });
    if (!ok) anyFailed = true;
  }

  if (anyFailed) process.exit(1);
}

/**
 * Detect local modifications across all core skills.
 * Returns array of { skill, changes } for skills with modifications.
 */
function detectCoreSkillChanges() {
  const results = [];
  if (!fs.existsSync(SKILLS_DIR)) return results;

  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const changes = detectChanges(skillDir);
    if (changes && (changes.modified.length > 0 || changes.added.length > 0)) {
      results.push({ skill: entry.name, changes });
    }
  }
  return results;
}

/**
 * Handle --self --check: check for zylos-core updates only (no lock needed).
 * Downloads new version to temp dir for file comparison by Claude.
 */
function handleSelfCheckOnly({ jsonOutput }) {
  const check = checkForCoreUpdates();

  if (!check.success) {
    if (jsonOutput) {
      const errOutput = { action: 'check', target: 'zylos-core', ...check };
      errOutput.reply = formatC4Reply('error', check);
      console.log(JSON.stringify(errOutput, null, 2));
    } else {
      console.error(`Error: ${check.message}`);
    }
    process.exit(1);
  }

  // When update is available: download to temp, read changelog, detect local changes
  let changelog = null;
  let tempDir = null;

  if (check.hasUpdate) {
    // Download new version to temp dir (for template/file comparison by Claude)
    const dlResult = downloadCoreToTemp(check.latest);
    if (dlResult.success) {
      tempDir = dlResult.tempDir;

      // Read changelog from downloaded package (more reliable than remote fetch)
      const fullChangelog = readCoreChangelog(tempDir);
      changelog = filterChangelog(fullChangelog, check.current);
    } else {
      // Fallback: fetch changelog from remote
      try {
        const rawChangelog = fetchRawFile('zylos-ai/zylos-core', 'CHANGELOG.md', `v${check.latest}`);
        changelog = filterChangelog(rawChangelog, check.current);
      } catch {
        try {
          const rawChangelog = fetchRawFile('zylos-ai/zylos-core', 'CHANGELOG.md');
          changelog = filterChangelog(rawChangelog, check.current);
        } catch {
          // CHANGELOG.md may not exist
        }
      }
    }
  }

  // Detect local modifications to core skills
  const allLocalChanges = check.hasUpdate ? detectCoreSkillChanges() : [];

  if (jsonOutput) {
    const output = { action: 'check', target: 'zylos-core', ...check };
    if (changelog) output.changelog = changelog;
    const mappedChanges = allLocalChanges.length > 0
      ? allLocalChanges.map(({ skill, changes }) => ({ skill, modified: changes.modified, added: changes.added }))
      : null;
    if (mappedChanges) output.localChanges = mappedChanges;
    if (tempDir) output.tempDir = tempDir;
    output.reply = formatC4Reply('self-check', { ...check, changelog, localChanges: mappedChanges });
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (!check.hasUpdate) {
      console.log(success(`${bold('zylos-core')} is up to date (v${check.current})`));
    } else {
      console.log(`${bold('zylos-core')}: ${dim(check.current)} → ${bold(check.latest)}`);

      if (allLocalChanges.length > 0) {
        console.log(`\n${warn('Local modifications:')}`);
        for (const { skill, changes } of allLocalChanges) {
          for (const f of changes.modified) console.log(`  ${yellow('M')} ${skill}/${f}`);
          for (const f of changes.added) console.log(`  ${green('A')} ${skill}/${f}`);
        }
      }

      if (changelog) {
        console.log(`\n${heading('Changelog:')}\n${changelog}`);
      }

      if (tempDir) {
        console.log(`\n${dim(`Downloaded to: ${tempDir}`)}`);
      }
      console.log(`\n${dim('Run "zylos upgrade --self --yes" to upgrade.')}`);
    }
  }

  // NOTE: tempDir is NOT cleaned up here — it's kept for reuse by --yes --temp-dir
}

/**
 * Upgrade zylos-core itself.
 * Lock-first pattern, same as component upgrades.
 *
 * Returns true on success, false on failure.
 * Does NOT call process.exit() — caller decides exit behavior.
 */
async function upgradeSelfCore({ providedTempDir, branch } = {}) {
  const jsonOutput = process.argv.includes('--json');
  const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');
  let tempDir = providedTempDir || null;
  const tempDirWasProvided = !!providedTempDir;

  // 1. Acquire lock (reuse component lock mechanism with special name)
  const lockResult = acquireLock('_zylos-core');
  if (!lockResult.success) {
    if (jsonOutput) {
      const errOutput = { action: 'self_upgrade', success: false, error: lockResult.error };
      errOutput.reply = formatC4Reply('error', { message: lockResult.error });
      console.log(JSON.stringify(errOutput, null, 2));
    } else {
      console.error(`Error: ${lockResult.error}`);
    }
    return false;
  }

  try {
    // 2. Check for updates (skip version comparison when --branch is specified)
    const check = checkForCoreUpdates();

    if (!check.success && !branch) {
      if (jsonOutput) {
        const errOutput = { action: 'check', target: 'zylos-core', ...check };
        errOutput.reply = formatC4Reply('error', check);
        console.log(JSON.stringify(errOutput, null, 2));
      } else {
        console.error(`Error: ${check.message}`);
      }
      return false;
    }

    if (!branch && check.success && !check.hasUpdate) {
      if (jsonOutput) {
        const output = { action: 'check', target: 'zylos-core', ...check };
        output.reply = formatC4Reply('self-check', check);
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(success(`${bold('zylos-core')} is up to date (v${check.current})`));
      }
      return true;
    }

    // 3. Download new version to temp (skip if reusing from --check)
    if (tempDirWasProvided) {
      // Validate provided temp dir exists
      if (!fs.existsSync(tempDir)) {
        const msg = `Provided temp dir does not exist: ${tempDir}`;
        if (jsonOutput) {
          const errOutput = { action: 'self_upgrade', success: false, error: msg };
          errOutput.reply = formatC4Reply('error', { message: msg });
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error(`Error: ${msg}`);
        }
        return false;
      }
      if (!jsonOutput) {
        console.log(`\n${dim(`Reusing previously downloaded package: ${tempDir}`)}`);
      }
    } else {
      const downloadLabel = branch ? `zylos-core (branch: ${branch})` : `zylos-core@${check.latest}`;
      if (!jsonOutput) {
        console.log(`\nDownloading ${bold(downloadLabel)}...`);
      }

      const dlResult = downloadCoreToTemp(check.latest, branch);
      if (!dlResult.success) {
        if (jsonOutput) {
          const errOutput = { action: 'self_upgrade', success: false, error: dlResult.error };
          errOutput.reply = formatC4Reply('error', { message: dlResult.error });
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error(`Error: ${dlResult.error}`);
        }
        return false;
      }
      tempDir = dlResult.tempDir;
    }

    // 4. Show info: version diff, changelog, local modifications to core skills
    const fullCoreChangelog = readCoreChangelog(tempDir);
    const coreChangelog = filterChangelog(fullCoreChangelog, check.current);

    // Detect local modifications across all core skills
    const allLocalChanges = detectCoreSkillChanges();

    if (!jsonOutput) {
      console.log(`\n${bold('zylos-core')}: ${dim(check.current)} → ${bold(check.latest)}`);

      if (allLocalChanges.length > 0) {
        console.log(`\n${warn('LOCAL MODIFICATIONS DETECTED:')}`);
        for (const { skill, changes } of allLocalChanges) {
          for (const f of changes.modified) console.log(`  ${yellow('M')} ${skill}/${f}`);
          for (const f of changes.added) console.log(`  ${green('A')} ${skill}/${f}`);
        }
      }

      if (coreChangelog) {
        console.log(`\n${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
        console.log(heading('CHANGELOG'));
        console.log(`${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
        console.log(coreChangelog);
        console.log(`${heading('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}\n`);
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
      console.log(`Upgrading ${bold('zylos-core')}...`);
    }

    // 6. Execute self-upgrade — show progress in real time
    const result = runSelfUpgrade({
      tempDir,
      newVersion: check.latest,
      onStep: !jsonOutput ? printStep : undefined,
    });

    // Output result
    if (jsonOutput) {
      const output = { ...result };
      if (coreChangelog) output.changelog = coreChangelog;
      if (allLocalChanges.length > 0) {
        output.localChanges = allLocalChanges.map(({ skill, changes }) => ({
          skill,
          modified: changes.modified,
          added: changes.added,
        }));
      }
      output.reply = formatC4Reply('self-upgrade', { ...result, changelog: coreChangelog });
      console.log(JSON.stringify(output, null, 2));
    } else if (result.success) {
      console.log(`\n${success(`${bold('zylos-core')} upgraded: ${dim(result.from)} → ${bold(result.to)}`)}`);
      if (coreChangelog) {
        console.log(`\n${heading('Changelog:')}\n${coreChangelog}`);
      }

      // Show migration hints if any
      if (result.migrationHints?.length > 0) {
        console.log(`\n${warn('ACTION REQUIRED')} — Hook changes for ${bold('.claude/settings.json')}:`);
        for (const hint of result.migrationHints) {
          if (hint.type === 'missing_hook') {
            console.log(`  ${yellow(`[${hint.event}]`)} ${green('ADD')}    ${hint.command} ${dim(`(timeout: ${hint.timeout}ms)`)}`);
          } else if (hint.type === 'modified_hook') {
            console.log(`  ${yellow(`[${hint.event}]`)} ${yellow('UPDATE')} ${hint.command} ${dim(`(timeout: ${hint.timeout}ms)`)}`);
          } else if (hint.type === 'removed_hook') {
            console.log(`  ${yellow(`[${hint.event}]`)} ${dim('REMOVE')} ${hint.command}`);
          }
        }
        console.log(`\nUpdate hooks in ${bold('~/zylos/.claude/settings.json')} and restart Claude to apply.`);
      }

      // Clean backup after successful upgrade
      if (result.backupDir) {
        cleanupBackup(result.backupDir);
      }
    } else {
      console.log(`\n${error(`Self-upgrade failed (step ${result.failedStep}): ${result.error}`)}`);

      if (result.rollback?.performed) {
        console.log(`\n${bold('Auto-rollback performed:')}`);
        for (const r of result.rollback.steps) {
          if (r.success) {
            console.log(`  ${success(r.action)}`);
          } else {
            console.log(`  ${error(r.action)}`);
          }
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
  const checkOnly = args.includes('--check');
  const jsonOutput = args.includes('--json');
  const explicitPurge = args.includes('--purge') || args.includes('purge');
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const explicitConfirm = args.includes('confirm') || args.includes('purge');
  const force = args.includes('--force');
  const target = args.find(arg => !arg.startsWith('-') && arg !== 'confirm' && arg !== 'purge');

  if (!target) {
    console.error('Usage: zylos uninstall <name> [options]');
    console.log('\nOptions:');
    console.log('  --check    Preview what will be removed');
    console.log('  --json     Output in JSON format');
    console.log('  --purge    Also remove data directory');
    console.log('  --force    Remove even if other components depend on it');
    console.log('  --yes, -y  Skip confirmation (keeps data)');
    process.exit(1);
  }

  if (checkOnly) {
    return handleUninstallCheck(target, { jsonOutput });
  }

  const ok = await handleRemoveFlow(target, { purge: explicitPurge, skipConfirm: skipConfirm || explicitConfirm, force, jsonOutput });
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
 * Handle --check for uninstall: preview what will be removed.
 */
function handleUninstallCheck(target, { jsonOutput }) {
  const components = loadComponents();

  if (!components[target]) {
    const errMsg = `Component "${target}" is not installed.`;
    if (jsonOutput) {
      const output = { action: 'uninstall_check', component: target, error: 'not_installed', message: errMsg };
      output.reply = formatC4Reply('error', { message: errMsg });
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`Error: ${errMsg}`);
    }
    process.exit(1);
  }

  const comp = components[target];
  const skillDir = path.join(SKILLS_DIR, target);
  const dataDir = path.join(COMPONENTS_DIR, target);
  const serviceName = resolveServiceName(target);
  const dependents = findDependents(target);

  if (jsonOutput) {
    const output = {
      action: 'uninstall_check',
      component: target,
      version: comp.version,
      service: serviceName,
      skillDir,
      dataDir,
      bin: comp.bin || null,
      dependents,
    };
    output.reply = formatC4Reply('uninstall-check', {
      component: target,
      version: comp.version,
      service: serviceName,
      dependents,
      dataDir,
    });
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\nUninstall ${bold(`"${target}"`)} (v${bold(comp.version)})?`);
    console.log(`\n${bold('Will remove:')}`);
    console.log(`  Service:   ${serviceName} (pm2)`);
    console.log(`  Skill dir: ${dim(skillDir)}`);
    console.log(`  Data dir:  ${dim(dataDir)} (kept)`);
    if (comp.bin) {
      console.log(`  Bin links: ${Object.keys(comp.bin).join(', ')}`);
    }

    if (dependents.length > 0) {
      console.log(`\n${warn(`These components depend on "${target}":`)}`);
      for (const d of dependents) console.log(`  - ${bold(d)}`);
    }

    console.log(`\n${dim(`Run "zylos uninstall ${target} --yes" to proceed.`)}`);
  }
}

/**
 * Remove flow: dependency check → confirm → stop PM2 → delete dirs → update components.json.
 * Returns true on success, false on failure.
 */
async function handleRemoveFlow(target, { purge, skipConfirm, force, jsonOutput }) {
  const components = loadComponents();

  if (!components[target]) {
    const errMsg = `Component "${target}" is not installed.`;
    if (jsonOutput) {
      const output = { action: 'uninstall', component: target, success: false, error: errMsg };
      output.reply = formatC4Reply('error', { message: errMsg });
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`Error: ${errMsg}`);
    }
    return false;
  }

  const skillDir = path.join(SKILLS_DIR, target);
  const dataDir = path.join(COMPONENTS_DIR, target);

  // Check dependencies
  const dependents = findDependents(target);
  if (dependents.length > 0 && !force) {
    const errMsg = `Cannot remove "${target}" — depends: ${dependents.join(', ')}. Use --force.`;
    if (jsonOutput) {
      const output = { action: 'uninstall', component: target, success: false, error: errMsg, dependents };
      output.reply = formatC4Reply('error', { message: errMsg });
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`Error: Cannot remove "${target}" \u2014 the following components depend on it:`);
      for (const d of dependents) console.error(`  - ${bold(d)}`);
      console.error(`\n${dim('Use --force to remove anyway.')}`);
    }
    return false;
  }

  if (dependents.length > 0 && !jsonOutput) {
    console.log(warn(`The following components depend on "${target}":`));
    for (const d of dependents) console.log(`  - ${bold(d)}`);
    console.log('');
  }

  // Show what will be removed
  const serviceName = resolveServiceName(target);
  if (!jsonOutput) {
    console.log(`${bold(`Will remove "${target}":`)}`);
    console.log(`  Service:   ${serviceName} (pm2)`);
    console.log(`  Skill dir: ${dim(skillDir)}`);
    if (purge) {
      console.log(`  Data dir:  ${dim(dataDir)} ${red('(--purge)')}`);
    } else {
      console.log(`  Data dir:  ${dim(dataDir)} (kept)`);
    }
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

  // Execute removal, collect step results
  const steps = [];

  // 1. Stop + delete PM2 service (use execFileSync to avoid shell injection)
  try {
    try { execFileSync('pm2', ['stop', serviceName], { stdio: 'pipe' }); } catch { /* ignore */ }
    execFileSync('pm2', ['delete', serviceName], { stdio: 'pipe' });
    steps.push({ action: 'PM2 service removed', success: true });
    if (!jsonOutput) console.log(`  ${success(`PM2 service "${serviceName}" removed`)}`);
  } catch {
    steps.push({ action: 'PM2 service not found', success: false });
    if (!jsonOutput) console.log(`  ${dim('○')} ${dim(`PM2 service "${serviceName}" not found (skipped)`)}`);
  }

  // 2. Remove bin symlinks
  const comp = components[target];
  if (comp.bin) {
    unlinkBins(comp.bin);
    steps.push({ action: 'Bin symlinks removed', success: true });
    if (!jsonOutput) console.log(`  ${success('Bin symlinks removed')}`);
  }

  // 2.5. Remove Caddy routes
  const caddyResult = removeCaddyRoutes(target);
  if (caddyResult.success && caddyResult.action === 'removed') {
    steps.push({ action: 'Caddy routes removed', success: true });
    if (!jsonOutput) console.log(`  ${success('Caddy routes removed')}`);
  } else if (caddyResult.action === 'not_found') {
    // No routes to remove — skip silently
  } else if (!caddyResult.success) {
    steps.push({ action: 'Caddy route removal failed', success: false, error: caddyResult.error });
    if (!jsonOutput) console.log(`  ${error(`Caddy route removal failed: ${caddyResult.error}`)}`);
  }

  // 3. Remove skill directory
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    steps.push({ action: 'Skill directory removed', success: true });
    if (!jsonOutput) console.log(`  ${success('Skill directory removed')}`);
  } else {
    steps.push({ action: 'Skill directory not found', success: false });
    if (!jsonOutput) console.log(`  ${dim('○')} ${dim('Skill directory not found (skipped)')}`);
  }

  // 4. Remove data directory if --purge
  if (purge) {
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      steps.push({ action: 'Data directory removed', success: true });
      if (!jsonOutput) console.log(`  ${success('Data directory removed')}`);
    } else {
      steps.push({ action: 'Data directory not found', success: false });
      if (!jsonOutput) console.log(`  ${dim('○')} ${dim('Data directory not found (skipped)')}`);
    }
  } else {
    steps.push({ action: 'Data directory kept', success: true });
  }

  // 5. Update components.json
  delete components[target];
  saveComponents(components);
  steps.push({ action: 'Removed from components.json', success: true });
  if (!jsonOutput) console.log(`  ${success('Removed from components.json')}`);

  if (jsonOutput) {
    const output = { action: 'uninstall', component: target, success: true, steps };
    output.reply = formatC4Reply('uninstall', { component: target, success: true, steps });
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n${success(`${bold(target)} uninstalled.`)}`);
  }

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
    info.reply = formatC4Reply('info', { name: target, version: comp.version, description, type: comp.type, repo: comp.repo, service: { name: serviceName, ...pm2Status } });
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  // Human-readable output
  const skillExists = fs.existsSync(skillDir);
  const statusIcon = skillExists ? green('✓') : red('✗');
  console.log(`\n${bold(target)} (v${bold(comp.version)}) ${statusIcon}\n`);

  if (description) console.log(`  Description:  ${description}`);
  console.log(`  Type:         ${comp.type || 'unknown'}`);
  console.log(`  Repo:         ${dim(comp.repo)}`);
  if (comp.installedAt) console.log(`  Installed:    ${dim(comp.installedAt)}`);
  if (comp.upgradedAt) console.log(`  Upgraded:     ${dim(comp.upgradedAt)}`);

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
    const statusColor = (pm2Status.status === 'online' || pm2Status.status === 'running') ? green : (pm2Status.status === 'stopped' || pm2Status.status === 'errored') ? red : (s) => s;
    console.log(`  Status:       ${statusColor(pm2Status.status)} (pid ${pm2Status.pid}${uptimeStr})`);
  } else {
    console.log(`  Service:      ${serviceName} (pm2)`);
    console.log(`  Status:       ${red('not running')}`);
  }

  // Directories
  console.log('');
  console.log(`  Skill Dir:    ${dim(skillDir)}`);
  console.log(`  Data Dir:     ${dim(dataDir)}`);

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
      if (changes.modified.length) parts.push(`${yellow(`${changes.modified.length} modified`)}`);
      if (changes.added.length) parts.push(`${green(`${changes.added.length} added`)}`);
      if (changes.deleted.length) parts.push(`${red(`${changes.deleted.length} deleted`)}`);
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
    console.log(`\n${dim('Use "zylos search <keyword>" to find available components.')}`);
    console.log(dim('Use "zylos add <name>" to install a component.'));
    return;
  }

  console.log(`${heading('Installed Components')}\n${heading('====================')}\n`);

  for (const name of names) {
    const comp = components[name];
    const skillDir = path.join(SKILLS_DIR, name);
    const installed = fs.existsSync(skillDir) ? green('✓') : red('✗');

    console.log(`${installed} ${bold(name)} (v${bold(comp.version)})`);
    console.log(`  Type: ${comp.type || 'unknown'}`);
    console.log(`  Repo: ${dim(comp.repo)}`);
    console.log(`  Installed: ${dim(comp.installedAt || 'unknown')}`);
    console.log('');
  }
}

export async function searchComponents(args) {
  const keyword = args[0] || '';

  console.log(`${dim('Searching components...')}\n`);

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
      console.log(`\n${dim('Try searching without keyword or install directly:')}`);
      console.log(dim('  zylos add <github-url>'));
    }
    return;
  }

  console.log(`${heading('Available Components')}\n${heading('====================')}\n`);

  const installed = loadComponents();

  for (const comp of results) {
    const status = installed[comp.name] ? green('[installed]') : '';
    console.log(`${bold(comp.name)} ${status}`);
    console.log(`  ${comp.description}`);
    console.log(`  Type: ${comp.type} | Repo: ${dim(comp.repo)}`);
    console.log('');
  }

  console.log(`Found ${bold(`${results.length}`)} component(s).`);
  console.log(`\n${dim('Use "zylos add <name>" to install a component.')}`);
}
