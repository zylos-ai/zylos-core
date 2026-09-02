/**
 * Component management commands
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ZYLOS_DIR, SKILLS_DIR, COMPONENTS_DIR, getZylosConfig } from '../lib/config.js';
import { bold, dim, green, red, yellow, cyan, success, error, warn, heading } from '../lib/colors.js';
import { loadRegistry } from '../lib/registry.js';
import { loadComponents, saveComponents } from '../lib/components.js';
import { checkForUpdates, getLocalSourceUpgradeError, getRepo, runUpgrade, downloadToTemp, readChangelog, filterChangelog, cleanupTemp, getLocalVersion, checkDowngradeSchemaCompatibility } from '../lib/upgrade.js';
import { compareSemverDesc } from '../lib/github.js';
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
export function printStep(step) {
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
  if (step.name === 'caddy_routes' && step.caddy?.action === 'manual_required') {
    console.log(`       ${yellow(step.caddy.message || 'HTTP routes were not configured automatically.')}`);
    if (step.caddy.caddyBin) console.log(`       ${dim(`Binary: ${step.caddy.caddyBin}`)}`);
    if (step.caddy.caddyfile) console.log(`       ${dim(`Caddyfile: ${step.caddy.caddyfile}`)}`);
    console.log('       If you use your own Caddy server, add this snippet inside your site block:');
    for (const line of (step.caddy.manualConfig || '').split('\n')) {
      console.log(line);
    }
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
      const { component, success, from, to, changelog, failedStep, error, rollback, mergeConflicts, mergedFiles } = data;
      if (!success) {
        let r = `${component} upgrade failed (step ${failedStep}): ${error}`;
        if (rollback?.performed) {
          r += '\nRollback: ' + rollback.steps.map(s => `${s.success ? 'OK' : 'FAIL'}: ${s.action}`).join(', ');
        }
        return r;
      }
      let r = `${component} upgraded: ${from} -> ${to}`;
      if (changelog) r += `\n\nChangelog:\n${changelog}`;
      if (mergedFiles?.length > 0) {
        r += `\n\nAuto-merged files: ${mergedFiles.join(', ')}`;
      }
      if (mergeConflicts?.length > 0) {
        const withBackup = mergeConflicts.filter(c => c.backupPath);
        const withoutBackup = mergeConflicts.filter(c => !c.backupPath);
        if (withBackup.length > 0) {
          r += '\n\nConflict files (local backed up, new version applied):';
          for (const c of withBackup) r += `\n  ${c.file} → backup: ${c.backupPath}`;
          r += '\n\nUse Claude to review and re-merge backed-up local changes.';
        }
        if (withoutBackup.length > 0) {
          r += `\n\nOverwritten without backup (${withoutBackup.length}): ${withoutBackup.map(c => c.file).join(', ')}`;
        }
      }
      return r;
    }
    case 'self-upgrade': {
      const { success, from, to, changelog, failedStep, error, rollback, migrationHints, mergeConflicts, mergedFiles, instructionFilesRebuilt, settingsChanged } = data;
      if (!success) {
        let r = `zylos-core upgrade failed (step ${failedStep}): ${error}`;
        if (rollback?.performed) {
          r += '\nRollback: ' + rollback.steps.map(s => `${s.success ? 'OK' : 'FAIL'}: ${s.action}`).join(', ');
        }
        return r;
      }
      let r = `zylos-core upgraded: ${from} -> ${to}`;
      if (changelog) r += `\n\nChangelog:\n${changelog}`;
      if (mergedFiles?.length > 0) {
        r += `\n\nAuto-merged files: ${mergedFiles.join(', ')}`;
      }
      if (mergeConflicts?.length > 0) {
        const withBackup = mergeConflicts.filter(c => c.backupPath);
        const withoutBackup = mergeConflicts.filter(c => !c.backupPath);
        if (withBackup.length > 0) {
          r += '\n\nConflict files (local backed up, new version applied):';
          for (const c of withBackup) r += `\n  ${c.skill}/${c.file} → backup: ${c.backupPath}`;
          r += '\n\nUse Claude to review and re-merge backed-up local changes.';
        }
        if (withoutBackup.length > 0) {
          r += `\n\nOverwritten without backup (${withoutBackup.length}): ${withoutBackup.map(c => `${c.skill}/${c.file}`).join(', ')}`;
        }
      }
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
      if (instructionFilesRebuilt || settingsChanged) {
        const what = [
          instructionFilesRebuilt && 'instruction files',
          settingsChanged && 'hook settings',
        ].filter(Boolean).join(' and ');
        r += `\n\n${what.charAt(0).toUpperCase() + what.slice(1)} updated — Claude will restart automatically to load the new configuration. No action needed.`;
      }
      return r;
    }
    case 'check-all': {
      const { total, updatable, components } = data;
      const failed = components.filter(c => !c.success);
      if (updatable === 0 && failed.length === 0) return 'All components are up to date.';

      const sections = [];
      if (failed.length > 0) {
        let failures = `${failed.length} of ${total} component check(s) failed:`;
        for (const c of failed) {
          failures += `\n  ${c.component}: ${c.message || c.error || 'unknown error'}`;
        }
        sections.push(failures);
      }
      if (updatable > 0) {
        let updates = `${updatable} of ${total} component(s) have updates:`;
        for (const c of components) {
          if (c.success && c.hasUpdate) updates += `\n  ${c.component}: ${c.current} -> ${c.latest}`;
        }
        updates += '\n\nUse "check <name>" to see details, or "upgrade <name>" to preview.';
        sections.push(updates);
      }
      return sections.join('\n\n');
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
  const beta = args.includes('--beta');
  const hasTempDirFlag = args.includes('--temp-dir');

  if (hasTempDirFlag) {
    const msg = '--temp-dir is not supported.';
    if (jsonOutput) {
      const errOutput = { action: 'upgrade', success: false, error: msg };
      errOutput.reply = formatC4Reply('error', { message: msg });
      console.log(JSON.stringify(errOutput, null, 2));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  // Parse --branch <name> flag
  const branchIndex = args.indexOf('--branch');
  const branch = branchIndex !== -1 ? args[branchIndex + 1] : null;
  if (branchIndex !== -1 && (!branch || branch.startsWith('-'))) {
    console.error('Error: --branch requires a branch name.');
    process.exit(1);
  }

  // --beta and --branch are mutually exclusive
  if (beta && branch) {
    console.error('Error: --beta and --branch are mutually exclusive.');
    process.exit(1);
  }

  // Parse --mode <value> flag (merge or overwrite)
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex !== -1 ? args[modeIndex + 1] : 'merge';
  if (modeIndex !== -1 && (!mode || mode.startsWith('-'))) {
    console.error('Error: --mode requires a value (merge or overwrite).');
    process.exit(1);
  }
  if (mode !== 'merge' && mode !== 'overwrite') {
    console.error(`Error: --mode must be "merge" or "overwrite", got "${mode}".`);
    process.exit(1);
  }

  // Get target component (filter out flags and flag values)
  const flagsWithValues = new Set(['--branch', '--mode']);
  const target = args.find((a, i) => {
    if (a.startsWith('-')) return false;
    if (a === 'confirm') return false;
    // Skip values that follow flags with arguments
    if (i > 0 && flagsWithValues.has(args[i - 1])) return false;
    return true;
  });

  // Parse "<component>@<version>" pin syntax: a positional version pin that
  // performs a version-pinned upgrade OR downgrade of an already-installed
  // component (bidirectional — unlike `zylos add <c>@<v>`, which is a no-op
  // once installed). See handlePinnedUpgrade() below.
  let component = target;
  let pinnedVersion = null;
  if (target && target.includes('@')) {
    const atIndex = target.indexOf('@');
    component = target.slice(0, atIndex);
    pinnedVersion = target.slice(atIndex + 1);
    if (!component || !pinnedVersion) {
      console.error('Error: invalid "<component>@<version>" syntax. Expected e.g. "lark@1.2.3".');
      process.exit(1);
    }
  }

  if (pinnedVersion && (branch || upgradeSelf || upgradeAll || beta)) {
    console.error('Error: a pinned version ("<component>@<version>") cannot be combined with --branch, --self, --all, or --beta.');
    process.exit(1);
  }
  if (pinnedVersion && modeIndex !== -1) {
    console.error('Error: --mode is not applicable with a pinned version — a pinned upgrade always performs a clean reinstall.');
    process.exit(1);
  }

  // Handle --self: upgrade zylos-core itself
  if (upgradeSelf) {
    if (checkOnly) {
      return handleSelfCheckOnly({ jsonOutput, branch, beta });
    }
    const ok = await upgradeSelfCore({ branch, beta, mode });
    if (!ok) process.exit(1);
    return;
  }

  // Handle --all: upgrade all components
  if (upgradeAll) {
    return upgradeAllComponents({ checkOnly, jsonOutput, skipConfirm, skipEval, beta, mode });
  }

  // Validate target
  if (!target) {
    console.error('Usage: zylos upgrade <name> [options]');
    console.error('       zylos upgrade <name>@<version>');
    console.error('       zylos upgrade --all');
    console.error('       zylos upgrade --self');
    console.log('\nOptions:');
    console.log('  --check        Check for updates only (downloads to temp for comparison)');
    console.log('  --json         Output in JSON format');
    console.log('  --yes, -y      Skip confirmation');
    console.log('  --skip-eval    Skip upgrade analysis of local changes');
    console.log('  --beta         Include prerelease (beta) versions');
    console.log('  --branch <b>   Upgrade from a specific branch (e.g. feat/xxx)');
    console.log('  --mode <m>     Merge mode: "merge" (default, smart three-way) or "overwrite"');
    console.log('\nExamples:');
    console.log('  zylos upgrade telegram --check --json');
    console.log('  zylos upgrade --self --check --beta');
    console.log('  zylos upgrade telegram --yes');
    console.log('  zylos upgrade telegram --mode overwrite');
    console.log('  zylos upgrade telegram@1.2.3   Pin to an exact version (upgrade OR downgrade)');
    process.exit(1);
  }

  // Verify component is installed (both in components.json and skill directory)
  const components = loadComponents();
  const skillDir = path.join(SKILLS_DIR, component);

  if (!components[component]) {
    const result = {
      action: 'check',
      component,
      error: 'component_not_registered',
      message: `Component '${component}' is not registered in components.json`,
      reply: `Component '${component}' is not installed.`,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.message}`);
    }
    process.exit(1);
  }

  const localSourceError = getLocalSourceUpgradeError(component, components[component]);
  if (localSourceError) {
    const result = {
      action: checkOnly ? 'check' : 'upgrade',
      component,
      ...localSourceError,
      reply: localSourceError.message,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${localSourceError.message}`);
    }
    process.exit(1);
  }

  // A pinned upgrade is explicitly designed to recover a component whose
  // skill directory is missing entirely (half-installed / previously wiped —
  // requirement: "independent of running state"), so this guard is skipped
  // for the pinned path. handlePinnedUpgrade()/runUpgrade() self-heal it.
  if (!fs.existsSync(skillDir) && !pinnedVersion) {
    const result = {
      action: 'check',
      component,
      error: 'skill_dir_not_found',
      message: `Component directory not found: ${skillDir}`,
      reply: `Component '${component}' directory not found.`,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.message}`);
    }
    process.exit(1);
  }

  // Pinned version path: zylos upgrade <component>@<version>
  if (pinnedVersion) {
    if (checkOnly) {
      const current = components[component]?.version || null;
      // compareSemverDesc(a, b) > 0 means b is higher than a (see checkForUpdates).
      // a = pinnedVersion (target), b = current: cmp > 0 ⇒ current > target ⇒ downgrade.
      const cmp = current ? compareSemverDesc(pinnedVersion, current) : null;
      const direction = cmp === null ? 'unknown' : cmp > 0 ? 'downgrade' : cmp < 0 ? 'upgrade' : 'reinstall';

      // A real pre-check, not just a components.json diff: confirm the
      // requested tag actually exists (download it to temp, exactly like the
      // non-pinned --check path below does), and — when the direction is a
      // downgrade — run the same schema-compatibility precheck the actual
      // pinned upgrade would run, so `--check` surfaces a would-be refusal
      // before the user attempts it for real.
      const repo = getRepo(component);
      if (!repo) {
        const msg = 'No repo configured for this component';
        if (jsonOutput) {
          const errOutput = { action: 'check', component, success: false, error: 'no_repo_configured', message: msg };
          errOutput.reply = formatC4Reply('error', { message: msg });
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }

      let tempDir = null;
      try {
        let dlResult;
        try {
          dlResult = downloadToTemp(repo, pinnedVersion, null, { allowFallback: false });
        } catch (err) {
          dlResult = { success: false, error: err.message };
        }
        if (!dlResult.success) {
          const msg = `Could not resolve ${component}@${pinnedVersion}: ${dlResult.error}`;
          if (jsonOutput) {
            const errOutput = { action: 'check', component, success: false, error: 'version_download_failed', message: msg };
            errOutput.reply = formatC4Reply('error', { message: msg });
            console.log(JSON.stringify(errOutput, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          process.exit(1);
        }
        tempDir = dlResult.tempDir;

        if (direction === 'downgrade') {
          const compat = checkDowngradeSchemaCompatibility(skillDir, tempDir);
          if (!compat.compatible) {
            if (jsonOutput) {
              const errOutput = { action: 'check', component, success: false, error: 'downgrade_incompatible_schema', message: compat.error };
              errOutput.reply = formatC4Reply('error', { message: compat.error });
              console.log(JSON.stringify(errOutput, null, 2));
            } else {
              console.error(`Error: ${compat.error}`);
            }
            process.exit(1);
          }
        }

        const result = { action: 'check', component, success: true, current, target: pinnedVersion, direction };
        if (jsonOutput) {
          result.reply = `${component}: ${current || 'unknown'} -> ${pinnedVersion} (${direction})`;
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${bold(component)}: ${dim(current || 'unknown')} -> ${bold(pinnedVersion)} (${direction})`);
        }
        return;
      } finally {
        cleanupTemp(tempDir);
      }
    }
    const ok = await handlePinnedUpgrade(component, pinnedVersion, { jsonOutput, skipConfirm: skipConfirm || explicitConfirm });
    if (!ok) process.exit(1);
    return;
  }

  // Mode 1: Check only (--check) — no lock, downloads to temp for file comparison
  if (checkOnly) {
    return handleCheckOnly(component, { jsonOutput, branch, beta });
  }

  // Mode 2 & 3: Full upgrade flow (lock-first)
  const ok = await handleUpgradeFlow(component, { jsonOutput, skipConfirm: skipConfirm || explicitConfirm, skipEval, branch, beta, mode });
  if (!ok) process.exit(1);
}

/**
 * Handle --check flag: check for updates only (no lock needed).
 * Also fetches changelog, detects local changes, and runs Claude eval for a complete preview.
 * When --branch is specified, downloads from branch and reads version from its package.json.
 */
async function handleCheckOnly(component, { jsonOutput, branch, beta = false }) {
  const result = checkForUpdates(component, { beta });

  if (!result.success) {
    if (!branch) {
      if (jsonOutput) {
        const errOutput = { action: 'check', component, ...result };
        errOutput.reply = formatC4Reply('error', result);
        console.log(JSON.stringify(errOutput, null, 2));
      } else {
        console.error(`Error: ${result.message}`);
      }
      process.exit(1);
    }
    // When --branch is specified, version check failure is non-fatal
  }

  // Enrich with changelog, local changes, and Claude eval when update is available
  let changelog = null;
  let localChanges = null;
  let evalResult = null;
  let tempDir = null;

  // With --branch: always download from branch and read version from its package.json
  const shouldDownload = branch || (result.hasUpdate && result.repo);

  if (shouldDownload) {
    const repo = result.repo || (branch ? getRepo(component) : null);
    if (repo) {
      let dlResult;
      try {
        dlResult = downloadToTemp(repo, result.latest, branch);
      } catch (err) {
        dlResult = { success: false, error: err.message };
      }
      if (dlResult.success) {
        tempDir = dlResult.tempDir;

        // When using --branch, read version from the downloaded package.json
        if (branch) {
          try {
            const branchPkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
            result.latest = branchPkg.version || result.latest;
            result.hasUpdate = result.current !== result.latest;
            result.success = true;
            result.repo = repo;
            result.branch = branch;
          } catch {
            // If package.json read fails, keep existing result
          }
        }

        // Read changelog from downloaded package (more reliable than remote fetch)
        const fullChangelog = readChangelog(tempDir);
        changelog = filterChangelog(fullChangelog, result.current);
      } else if (!branch) {
        // Fallback: fetch changelog from remote (only for non-branch)
        try {
          const rawChangelog = fetchRawFile(result.repo, 'CHANGELOG.md', `v${result.latest}`);
          changelog = filterChangelog(rawChangelog, result.current);
        } catch {
          // CHANGELOG.md may not exist — that's fine
        }
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
    if (branch) output.branch = branch;
    if (changelog) output.changelog = changelog;
    if (localChanges) output.localChanges = localChanges;
    if (evalResult) output.evaluation = evalResult;
    output.reply = formatC4Reply('check', { component, ...result, changelog, localChanges, evaluation: evalResult });
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (!result.hasUpdate && !branch) {
      console.log(success(`${bold(component)} is up to date (v${result.current})`));
    } else if (result.hasUpdate) {
      const label = branch ? `${dim(result.current)} → ${bold(result.latest)} (branch: ${branch})` : `${dim(result.current)} → ${bold(result.latest)}`;
      console.log(`${bold(component)}: ${label}`);

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

      console.log(`\n${dim(`Run "zylos upgrade ${component} --yes" to upgrade.`)}`);
    } else {
      // --branch specified but branch version matches installed version
      console.log(success(`${bold(component)} is up to date with branch ${bold(branch)} (v${result.current})`));
    }
  }

  cleanupTemp(tempDir);
}

/**
 * Full upgrade flow with lock-first pattern.
 * Lock wraps the entire operation: check → download → confirm → execute → cleanup.
 *
 * Returns true on success, false on failure.
 * Does NOT call process.exit() — caller decides exit behavior.
 */
async function handleUpgradeFlow(component, { jsonOutput, skipConfirm, skipEval, branch, beta = false, mode = 'merge' }) {
  const skillDir = path.join(SKILLS_DIR, component);
  let tempDir = null;

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
    const check = checkForUpdates(component, { beta });

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

    // 3. Download new version to temp (always fresh in confirm/--yes flow)
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
      console.log(`\n${dim('Confirm flow uses a fresh download (check artifacts are not reused).')}`);
      console.log(`Downloading ${bold(downloadLabel)}...`);
    }

    let dlResult;
    try {
      dlResult = downloadToTemp(repo, check.latest, branch);
    } catch (err) {
      dlResult = { success: false, error: err.message };
    }
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

    // 4. Show info: version diff, changelog, local changes + Claude eval
    const changes = detectChanges(skillDir);
    const fullChangelog = readChangelog(tempDir);
    const changelog = filterChangelog(fullChangelog, check.current);
    let evalResult = null;

    if (!jsonOutput) {
      console.log(`\n${bold(component)}: ${dim(check.current)} → ${bold(check.latest)}`);
      const targetVersion = check.latest || (branch ? `branch:${branch}` : 'unknown');
      const targetRef = branch ? `branch:${branch}` : `tag:v${check.latest}`;
      console.log(dim(`Target package: ${targetVersion} (${targetRef})`));

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
      mode,
      jsonOutput,
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
 * Handle a version-pinned upgrade or downgrade: `zylos upgrade <component>@<version>`.
 *
 * Unlike the ordinary upgrade flow, this is NOT a "check for updates and stop
 * if already current" operation — it is "ensure <component> is materialized
 * at exactly <version>", so it always runs the full download + clean
 * reinstall + restart pipeline, even if the currently-recorded version
 * already matches the target (that idempotent re-materialize is what makes
 * it usable as a recovery path for a crashed/half-installed component: see
 * runUpgrade's `pinned: true` mode in cli/lib/upgrade.js).
 *
 * Success is judged ONLY by a post-condition read-back, and — per
 * fail-before-mutate (design doc §3.4, zylos0t review #771) — the registry
 * (components.json) is never written until the disk swap has already been
 * independently confirmed: the downloaded package's own metadata is
 * validated against `version` BEFORE runUpgrade() ever touches disk; then,
 * after the pipeline reports success, the on-disk version is re-read
 * (SKILL.md/package.json) and confirmed FIRST; only then is the registry
 * written; then the registry is itself re-read (the exact same source
 * `zylos list` reads) to confirm the write stuck. A pipeline-success that
 * doesn't hold up under either read-back is reported as a failure
 * (`version_download_mismatch` pre-swap, `version_readback_mismatch`
 * post-swap), never as exit 0 — and in every failure case, no partial state
 * (disk swap without registry write, or vice versa) is left behind.
 *
 * Does NOT call process.exit() — caller decides exit behavior.
 */
async function handlePinnedUpgrade(component, version, { jsonOutput, skipConfirm }) {
  const skillDir = path.join(SKILLS_DIR, component);

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

  let tempDir = null;
  try {
    const repo = getRepo(component);
    if (!repo) {
      const msg = 'No repo configured for this component';
      if (jsonOutput) {
        const errOutput = { action: 'upgrade', component, success: false, error: 'no_repo_configured', message: msg };
        errOutput.reply = formatC4Reply('error', { message: msg });
        console.log(JSON.stringify(errOutput, null, 2));
      } else {
        console.error(`Error: ${msg}`);
      }
      return false;
    }

    const registeredVersion = loadComponents()[component]?.version || null;

    if (!jsonOutput) {
      console.log(`\nDownloading ${bold(`${component}@${version}`)}...`);
    }

    // Pinned installs must never silently substitute a different ref (e.g.
    // the `main` branch fallback used by the ordinary upgrade flow) when the
    // exact requested tag doesn't exist — that would materialize the wrong
    // version while still looking like a success.
    let dlResult;
    try {
      dlResult = downloadToTemp(repo, version, null, { allowFallback: false });
    } catch (err) {
      dlResult = { success: false, error: err.message };
    }
    if (!dlResult.success) {
      const msg = `Could not download ${component}@${version}: ${dlResult.error}`;
      if (jsonOutput) {
        const errOutput = { action: 'upgrade', component, success: false, error: 'version_download_failed', message: msg };
        errOutput.reply = formatC4Reply('error', { message: msg });
        console.log(JSON.stringify(errOutput, null, 2));
      } else {
        console.error(`Error: ${msg}`);
      }
      return false;
    }
    tempDir = dlResult.tempDir;

    // Refuse a downgrade that would leave forward-incompatible data on disk.
    // Direction is judged against the registered version (components.json) —
    // available even when skillDir/SKILL.md is missing (half-installed case).
    // compareSemverDesc(a, b) > 0 means b is higher than a: a = version
    // (target), b = registeredVersion (current) ⇒ cmp > 0 ⇒ current > target
    // ⇒ downgrade.
    const isDowngrade = registeredVersion ? compareSemverDesc(version, registeredVersion) > 0 : false;
    if (isDowngrade) {
      const compat = checkDowngradeSchemaCompatibility(skillDir, tempDir);
      if (!compat.compatible) {
        if (jsonOutput) {
          const errOutput = { action: 'upgrade', component, success: false, error: 'downgrade_incompatible_schema', message: compat.error };
          errOutput.reply = formatC4Reply('error', { message: compat.error });
          console.log(JSON.stringify(errOutput, null, 2));
        } else {
          console.error(`Error: ${compat.error}`);
        }
        return false;
      }
    }

    // Pre-swap metadata validation (fail-before-mutate, zylos0t review #771):
    // confirm the downloaded package actually IS the requested version before
    // any disk swap or registry write happens. tempDir is the same skill-tree
    // root already passed to checkDowngradeSchemaCompatibility() above, so
    // this reads the same tree runUpgrade()'s step3 would stage from. Without
    // this check, a tag that resolves but whose contents don't match (bad
    // release asset, mislabeled tag, etc.) would only be caught AFTER the
    // swap + registry write, via the post-condition read-back below — which
    // is too late for fail-before-mutate.
    const downloadedVersion = getLocalVersion(tempDir);
    if (downloadedVersion.version !== version) {
      const msg = downloadedVersion.success
        ? `Downloaded package for ${component} reports version ${downloadedVersion.version}, but ${version} was requested. Refusing to install — no files were changed.`
        : `Could not verify the downloaded package version for ${component}@${version}: ${downloadedVersion.error}. Refusing to install — no files were changed.`;
      if (jsonOutput) {
        const errOutput = { action: 'upgrade', component, success: false, error: 'version_download_mismatch', message: msg };
        errOutput.reply = formatC4Reply('error', { message: msg });
        console.log(JSON.stringify(errOutput, null, 2));
      } else {
        console.error(`Error: ${msg}`);
      }
      return false;
    }

    if (!skipConfirm) {
      const label = registeredVersion ? `${registeredVersion} -> ${version}` : `-> ${version}`;
      const confirmed = await promptYesNo(`Pin ${component} to version ${version} (${label}, clean reinstall)? [y/N]: `);
      if (!confirmed) {
        console.log('Upgrade cancelled.');
        return true; // Not an error — user chose to cancel
      }
    } else if (!jsonOutput) {
      console.log(`Installing ${bold(component)}@${version} (clean reinstall)...`);
    }

    // Clean, tree-mirroring reinstall — independent of current process
    // health/registration, and force-ensures the service ends up running.
    const result = runUpgrade(component, {
      tempDir,
      newVersion: version,
      pinned: true,
      jsonOutput,
      onStep: !jsonOutput ? printStep : undefined,
    });

    // Post-condition read-back (the actual success criterion) — restructured
    // per fail-before-mutate (zylos0t review #771, design doc §3.4): a
    // pinned/downgrade install either fully succeeds or leaves NO partial
    // state. The registry (components.json + bin symlinks) is therefore only
    // ever written AFTER the on-disk swap has been independently confirmed —
    // never before. Order:
    //   1. runUpgrade() already ran above (the swap).
    //   2. Disk read-back FIRST, before any registry mutation.
    //   3. Only if disk read-back passes: write the registry.
    //   4. Registry read-back, to confirm the write itself stuck.
    //
    // Version equality alone is NOT sufficient (daniel round-3 finding): an
    // unrelated, previously-broken tree — left behind by the old,
    // non-pinned upgrade path's best-effort rollback, which tolerates a
    // failed restore (cli/lib/upgrade.js rollback()'s restore_files is
    // caught, not thrown) — can coincidentally already show metadata equal
    // to `version` (same-version retry, or a `latest` dispatch that happens
    // to equal a stale target) even though THIS attempt never got far enough
    // to touch it (e.g. it failed during download, before runUpgrade ever
    // ran). `result.pinnedSwapCompleted` is the defense against exactly
    // that: it is set by runUpgrade only when step3_pinnedCleanReinstall's
    // atomic swap-in genuinely completed during THIS invocation, so "ready"
    // here means "version == target (necessary, not sufficient) AND this
    // attempt actually performed the swap" — never version-equality by
    // itself. An unreadable disk version (diskCheck.success === false)
    // yields diskVersion === null, which never equals `version`, so it is
    // always judged failed here, never "indeterminate".
    let finalResult = result;
    if (result.success) {
      const diskCheck = getLocalVersion(skillDir);
      const diskVersion = diskCheck.success ? diskCheck.version : null;
      const swapCompletedThisAttempt = result.pinnedSwapCompleted === true;

      if (diskVersion !== version || !swapCompletedThisAttempt) {
        // Disk read-back failed: do NOT write the registry. components.json
        // is left exactly as it was before this attempt.
        finalResult = {
          ...result,
          success: false,
          error: 'version_readback_mismatch',
          message: swapCompletedThisAttempt
            ? `Upgrade pipeline reported success but the on-disk version could not be verified: on-disk=${diskVersion ?? 'unknown'}, target=${version}. Registry left unchanged.`
            : `Upgrade pipeline reported success but this attempt never completed the clean-reinstall swap-in — on-disk version (${diskVersion ?? 'unknown'}) cannot be trusted as this attempt's result, target=${version}. Registry left unchanged.`,
        };
      } else {
        // Disk read-back passed — safe to write the registry now.
        const components = loadComponents();
        if (components[component]) {
          // P1 (zylos0t re-review #771): write the VALIDATED request version,
          // never `result.to`. The guard above already proved
          // `diskVersion === version`, so `version` is the authoritative,
          // disk-verified truth. Using `result.to || version` could write a
          // value that diverges from the validated target (e.g. runUpgrade
          // reporting `to: "2.0.0+wrong"` when the request/disk are `2.0.0`),
          // which the registry read-back below would then reject AFTER having
          // already mutated components.json — a fail-with-mutation that
          // violates §3.4 fail-before-mutate. Pinning `version` (never
          // `result.to`) removes that divergence source entirely.
          components[component].version = version;
          components[component].upgradedAt = new Date().toISOString();
          // Fix 3 (zylos0t review #771): persist the exact release tag used
          // for this pin, matching the `source` shape resolveGitHubTarget()
          // produces on install (cli/lib/components.js) — never a branch ref,
          // since the pinned path always downloads by tag (allowFallback:
          // false, no branch). This prevents a stale `source` (e.g. from an
          // earlier branch/local install) from surviving a pin.
          components[component].source = { type: 'github-release', repo, ref: version, refType: 'tag' };

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

        // Registry read-back: confirm the write itself stuck (freshly
        // reloaded from disk, the same source `zylos list` reads).
        const freshComponents = loadComponents();
        const registryVersion = freshComponents[component]?.version || null;

        if (registryVersion !== version) {
          finalResult = {
            ...result,
            success: false,
            error: 'version_readback_mismatch',
            message: `Upgrade pipeline reported success and the on-disk version was verified (${version}), but components.json could not be verified after the registry write: components.json=${registryVersion ?? 'unknown'}, target=${version}.`,
          };
        } else {
          // Fully successful: disk swap AND registry write both verified.
          // Report the validated request version as the installed version —
          // it is the disk- and registry-verified truth. `result.to` is never
          // used as the source of truth (see the registry write above), so it
          // must not leak into the JSON output / success message either.
          finalResult = { ...result, to: version };
          cleanOldBackups(skillDir);
        }
      }
    }

    if (jsonOutput) {
      const output = { ...finalResult };
      output.reply = formatC4Reply('upgrade', { component, ...finalResult });
      console.log(JSON.stringify(output, null, 2));
    } else if (finalResult.success) {
      console.log(`\n${success(`${bold(component)} pinned to version ${bold(finalResult.to)}`)}`);
    } else if (result.success && !finalResult.success) {
      console.log(`\n${error(`Upgrade completed but version verification failed: ${finalResult.message}`)}`);
    } else {
      console.log(`\n${error(`Upgrade failed (step ${result.failedStep}): ${result.error}`)}`);
      if (result.rollback?.performed) {
        console.log(`\n${bold('Auto-rollback performed:')}`);
        for (const r of result.rollback.steps) {
          console.log(`  ${r.success ? success(r.action) : error(r.action)}`);
        }
      }
    }

    return finalResult.success;
  } finally {
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
async function upgradeAllComponents({ checkOnly, jsonOutput, skipConfirm, skipEval, beta = false, mode = 'merge' }) {
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

    const check = checkForUpdates(name, { beta });
    results.push({ component: name, ...check });

    if (!jsonOutput && check.success && check.hasUpdate) {
      console.log(`  ${dim(check.current)} → ${bold(check.latest)}`);
    } else if (!jsonOutput && !check.success) {
      console.log(`  ${warn(check.message || check.error)}`);
    }
  }

  const updatable = results.filter(r => r.success && r.hasUpdate);
  const failed = results.filter(r => !r.success);

  if (jsonOutput) {
    const output = {
      action: checkOnly ? 'check_all' : 'upgrade_all',
      success: failed.length === 0,
      total: names.length,
      updatable: updatable.length,
      failed: failed.length,
      components: results,
    };
    output.reply = formatC4Reply('check-all', { total: names.length, updatable: updatable.length, components: results });
    if (failed.length > 0) {
      output.error = 'component_checks_failed';
      output.message = `${failed.length} component check(s) failed`;
    }
    console.log(JSON.stringify(output, null, 2));
    if (failed.length > 0) process.exit(1);
    return;
  }

  // Unified exit-code contract (#706): component check failures fail the
  // command in non-JSON mode too, matching --json. process.exitCode (not
  // process.exit) so the remaining flow — prompts, upgrades, output — still
  // runs; a later upgrade failure keeps the same non-zero exit.
  if (failed.length > 0) process.exitCode = 1;

  if (updatable.length === 0) {
    if (failed.length > 0) {
      console.log(`\n${warn('No remotely updatable components found; see checks above.')}`);
    } else {
      console.log(`\n${success('All components are up to date.')}`);
    }
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
    const ok = await handleUpgradeFlow(comp.component, { jsonOutput, skipConfirm: true, skipEval, beta, mode });
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
function handleSelfCheckOnly({ jsonOutput, branch, beta = false }) {
  const check = checkForCoreUpdates({ branch, beta });

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

  // When update is available (or --branch forces re-check): download to temp, read changelog, detect local changes
  let changelog = null;
  let tempDir = null;

  // With --branch, always proceed even if versions match (user wants to install specific branch)
  if (check.hasUpdate || branch) {
    // Download new version to temp dir (for template/file comparison by Claude)
    let dlResult;
    try {
      dlResult = downloadCoreToTemp(check.latest, branch);
    } catch (err) {
      dlResult = { success: false, error: err.message };
    }
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
  const allLocalChanges = (check.hasUpdate || branch) ? detectCoreSkillChanges() : [];

  if (jsonOutput) {
    const output = { action: 'check', target: 'zylos-core', ...check };
    if (branch) output.branch = branch;
    if (changelog) output.changelog = changelog;
    const mappedChanges = allLocalChanges.length > 0
      ? allLocalChanges.map(({ skill, changes }) => ({ skill, modified: changes.modified, added: changes.added }))
      : null;
    if (mappedChanges) output.localChanges = mappedChanges;
    output.reply = formatC4Reply('self-check', { ...check, changelog, localChanges: mappedChanges });
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (!check.hasUpdate && !branch) {
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

      console.log(`\n${dim('Run "zylos upgrade --self --yes" to upgrade.')}`);
    }
  }

  cleanupCoreTemp(tempDir);
}

/**
 * Upgrade zylos-core itself.
 * Lock-first pattern, same as component upgrades.
 *
 * Returns true on success, false on failure.
 * Does NOT call process.exit() — caller decides exit behavior.
 */
async function upgradeSelfCore({ branch, beta = false, mode = 'merge' } = {}) {
  const jsonOutput = process.argv.includes('--json');
  const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');
  let tempDir = null;

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
    // 2. Check for updates (compare against branch when --branch is specified)
    const check = checkForCoreUpdates({ branch, beta });

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

    // 3. Download new version to temp (always fresh in confirm/--yes flow)
    const downloadLabel = branch ? `zylos-core (branch: ${branch})` : `zylos-core@${check.latest}`;
    if (!jsonOutput) {
      console.log(`\n${dim('Confirm flow uses a fresh download (check artifacts are not reused).')}`);
      console.log(`Downloading ${bold(downloadLabel)}...`);
    }

    let dlResult;
    try {
      dlResult = downloadCoreToTemp(check.latest, branch);
    } catch (err) {
      dlResult = { success: false, error: err.message };
    }
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

    // 4. Show info: version diff, changelog, local modifications to core skills
    const fullCoreChangelog = readCoreChangelog(tempDir);
    const coreChangelog = filterChangelog(fullCoreChangelog, check.current);

    // Detect local modifications across all core skills
    const allLocalChanges = detectCoreSkillChanges();

    if (!jsonOutput) {
      console.log(`\n${bold('zylos-core')}: ${dim(check.current)} → ${bold(check.latest)}`);
      const targetVersion = check.latest || (branch ? `branch:${branch}` : 'unknown');
      const targetRef = branch ? `branch:${branch}` : `tag:v${check.latest}`;
      console.log(dim(`Target package: ${targetVersion} (${targetRef})`));

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
      mode,
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
      // Auto-restart for instruction file changes (CLAUDE.md / AGENTS.md).
      // Settings hook changes are handled by sync-settings-hooks.js directly,
      // which enqueues /exit from the newly installed package — avoiding the
      // bootstrap problem where the old component.js lacks restart logic.
      if (result.success && result.instructionFilesRebuilt) {
        try {
          const activeRuntime = getZylosConfig().runtime ?? 'claude';
          if (activeRuntime === 'claude') {
            const c4ControlPath = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
            const { spawnSync } = await import('child_process');
            spawnSync('node', [c4ControlPath, 'enqueue', '--content', '/exit', '--priority', '1', '--block-queue-until-idle', '--no-ack-suffix'], { stdio: 'pipe' });
          }
        } catch { /* non-fatal */ }
      }
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

      if (result.mergeConflicts?.length > 0) {
        console.log(`\n${warn(`${result.mergeConflicts.length} conflict backup(s) retained:`)}`);
        for (const conflict of result.mergeConflicts) {
          console.log(`  ${yellow(`${conflict.skill}/${conflict.file}`)} -> ${conflict.backupPath}`);
        }
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
  // zylos uninstall --self → full system uninstall
  if (args.includes('--self')) {
    const hasTarget = args.some(a => !a.startsWith('-'));
    if (hasTarget) {
      console.error('Error: --self cannot be combined with a component name.');
      console.error('  To uninstall a component:  zylos uninstall <name>');
      console.error('  To uninstall zylos itself: zylos uninstall --self');
      process.exit(1);
    }
    const { selfUninstall } = await import('./self-uninstall.js');
    return selfUninstall(args);
  }

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
    console.log('  --self     Uninstall zylos entirely from the system');
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

  // 0. Run pre-uninstall hook (before stopping service or removing files)
  const skillMd = parseSkillMd(skillDir);
  const hooks = skillMd?.frontmatter?.lifecycle?.hooks || {};
  if (hooks['pre-uninstall']) {
    const hookPath = path.resolve(skillDir, hooks['pre-uninstall']);
    if (fs.existsSync(hookPath)) {
      if (!jsonOutput) console.log(`  ${cyan('Running pre-uninstall hook...')}`);
      try {
        execFileSync('node', [hookPath], {
          cwd: skillDir,
          stdio: jsonOutput ? 'pipe' : 'inherit',
          env: { ...process.env, ZYLOS_COMPONENT: target, ZYLOS_SKILL_DIR: skillDir, ZYLOS_DATA_DIR: dataDir },
        });
        steps.push({ action: 'Pre-uninstall hook complete', success: true });
        if (!jsonOutput) console.log(`  ${success('Pre-uninstall hook complete.')}`);
      } catch (err) {
        steps.push({ action: 'Pre-uninstall hook failed', success: false, error: err.message });
        if (!jsonOutput) console.log(`  ${warn('Pre-uninstall hook had issues (continuing anyway).')}`);
      }
    }
  }

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
