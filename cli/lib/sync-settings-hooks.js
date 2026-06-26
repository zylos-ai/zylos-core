#!/usr/bin/env node
/**
 * Sync settings.json hooks from template to installed settings.
 *
 * Compares template hooks with installed hooks by script path:
 * - Missing hooks → add
 * - Modified hooks → update (command, timeout)
 * - Removed hooks (core skills only) → remove
 * - User hooks (non-core skills) → preserve
 *
 * Called from postinstall.js and from self-upgrade step 8 (which shells
 * out to the newly installed copy of this script).
 *
 * Usage:
 *   node sync-settings-hooks.js           # Sync hooks
 *   node sync-settings-hooks.js --dry-run # Show what would change
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { extractScriptPath, extractSkillName, getCommandHooks } from './hook-utils.js';
import { getZylosConfig, updateZylosConfig } from './config.js';
import { renderCodexProjectConfig, renderCodexGlobalConfig, writeCodexConfig } from './runtime-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZYLOS_DIR = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
const TEMPLATE_SETTINGS = path.join(__dirname, '..', '..', 'templates', '.claude', 'settings.json');
const INSTALLED_SETTINGS = path.join(ZYLOS_DIR, '.claude', 'settings.json');

const MAX_SAFE_1M_THRESHOLD = 30;
const SESSION_START_OLD_SCRIPTS = [
  'skills/zylos-memory/scripts/session-start-inject.js',
  'skills/comm-bridge/scripts/c4-session-init.js',
  'skills/activity-monitor/scripts/session-foreground.js',
  'skills/activity-monitor/scripts/session-start-prompt.js',
];
const SESSION_START_OLD_TIMEOUT_BY_SCRIPT = new Map([
  ['skills/zylos-memory/scripts/session-start-inject.js', 10000],
  ['skills/comm-bridge/scripts/c4-session-init.js', 10000],
  ['skills/activity-monitor/scripts/session-foreground.js', 5000],
  ['skills/activity-monitor/scripts/session-start-prompt.js', 5000],
]);
const SESSION_START_MATCHERS = ['startup', 'clear', 'compact'];

function is1mModel(model) {
  return typeof model === 'string' && model.includes('[1m]');
}

function strip1mSuffix(model) {
  return model.replace('[1m]', '');
}

export function syncTemplateModelSetting({
  templateSettings,
  installedSettings,
  cfg = getZylosConfig(),
  dryRun = false,
  log = console.log,
} = {}) {
  if (!Object.hasOwn(templateSettings, 'model') || Object.hasOwn(installedSettings, 'model')) {
    return { changed: false };
  }

  let model = templateSettings.model;

  if (is1mModel(model) && Object.hasOwn(cfg, 'new_session_threshold') && cfg.new_session_threshold > MAX_SAFE_1M_THRESHOLD) {
    model = strip1mSuffix(model);
    log(`  ! model: ${templateSettings.model} → ${model} (new_session_threshold ${cfg.new_session_threshold} too high for 1M context)`);
  }

  if (!dryRun) {
    installedSettings.model = model;
  }
  log(`  + model: ${model}`);
  return { changed: true, model };
}

/**
 * Backfill a single top-level setting from the template when the installed
 * config does not already have it.  Used for boolean flags like
 * autoMemoryEnabled / autoDreamEnabled.
 */
export function syncTemplateSetting(key, {
  templateSettings,
  installedSettings,
  dryRun = false,
  log = console.log,
} = {}) {
  if (!Object.hasOwn(templateSettings, key) || Object.hasOwn(installedSettings, key)) {
    return { changed: false };
  }

  if (!dryRun) {
    installedSettings[key] = templateSettings[key];
  }
  log(`  + ${key}: ${templateSettings[key]}`);
  return { changed: true };
}

export function syncModelCoupledNewSessionThreshold({
  modelBackfilled = false,
  cfg = getZylosConfig(),
  updateConfig = updateZylosConfig,
  dryRun = false,
  log = console.log,
} = {}) {
  if (!modelBackfilled) {
    return { changed: false, reason: 'model_not_backfilled' };
  }

  if (Object.hasOwn(cfg, 'new_session_threshold')) {
    return { changed: false, reason: 'threshold_already_set' };
  }

  if (!dryRun) {
    updateConfig({ new_session_threshold: 30 });
  }
  log('  + new_session_threshold: 30 (paired with model backfill)');
  return { changed: true };
}

const DEFAULT_MAX_SETTINGS_BACKUPS = 5;

/**
 * Prune `<settings>.bak.<ts>` backups, keeping only the most recent `keep`.
 * Backups accumulate one-per-changed-sync and were never cleaned up. Best
 * effort: any fs error here must never break the settings write, so the
 * caller wraps this in a try/catch and we tolerate a missing directory.
 */
export function pruneOldBackups({
  settingsPath,
  keep = DEFAULT_MAX_SETTINGS_BACKUPS,
  readdirSync = fs.readdirSync,
  unlinkSync = fs.unlinkSync,
} = {}) {
  const dir = path.dirname(settingsPath);
  const base = path.basename(settingsPath);
  const backupRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak\\.(\\d+)$`);
  const backups = readdirSync(dir)
    .map((name) => {
      const m = name.match(backupRe);
      return m ? { name, ts: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts); // newest first
  for (const stale of backups.slice(keep)) {
    unlinkSync(path.join(dir, stale.name));
  }
}

export function persistInstalledSettingsAndSyncCoupledThreshold({
  installedSettings,
  settingsPath = INSTALLED_SETTINGS,
  modelBackfilled = false,
  maxBackups = DEFAULT_MAX_SETTINGS_BACKUPS,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
  existsSync = fs.existsSync,
  copyFileSync = fs.copyFileSync,
  readdirSync = fs.readdirSync,
  unlinkSync = fs.unlinkSync,
  syncThreshold = syncModelCoupledNewSessionThreshold,
} = {}) {
  const dir = path.dirname(settingsPath);
  mkdirSync(dir, { recursive: true });
  let backupPath = null;
  if (existsSync(settingsPath)) {
    backupPath = `${settingsPath}.bak.${Date.now()}`;
    copyFileSync(settingsPath, backupPath);
  }
  try {
    writeFileSync(settingsPath, JSON.stringify(installedSettings, null, 2) + '\n');
  } catch (err) {
    if (backupPath) {
      try { copyFileSync(backupPath, settingsPath); } catch {}
    }
    throw err;
  }
  if (backupPath) {
    try {
      pruneOldBackups({ settingsPath, keep: maxBackups, readdirSync, unlinkSync });
    } catch {
      // best effort — never fail a successful settings write over cleanup
    }
  }
  return syncThreshold({ modelBackfilled });
}

export function shouldSyncCodexConfig({
  cfg = getZylosConfig(),
  homeDir = os.homedir(),
  projectDir = ZYLOS_DIR,
  existsSync = fs.existsSync,
} = {}) {
  const codexDir = path.join(homeDir, '.codex');
  const globalConfigPath = path.join(codexDir, 'config.toml');
  const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
  const hasCodexState = existsSync(globalConfigPath) || existsSync(path.join(codexDir, 'auth.json'));
  return {
    cfg,
    globalConfigPath,
    projectConfigPath,
    // Keep legacy alias for any external callers
    configPath: globalConfigPath,
    shouldSync: cfg.runtime === 'codex' || hasCodexState,
  };
}

export function syncCodexConfig({
  dryRun = false,
  cfg = getZylosConfig(),
  projectDir = ZYLOS_DIR,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writeConfig = writeCodexConfig,
  log = console.log,
} = {}) {
  const state = shouldSyncCodexConfig({ cfg, homeDir, projectDir, existsSync });
  if (!state.shouldSync) {
    return { attempted: false, changed: false, fatal: false };
  }

  // Check both project-level and global config for drift
  let existingGlobal = '';
  try { existingGlobal = readFileSync(state.globalConfigPath, 'utf8'); } catch {}
  let existingProject = '';
  try { existingProject = readFileSync(state.projectConfigPath, 'utf8'); } catch {}

  const desiredProject = renderCodexProjectConfig(existingProject);
  const desiredGlobal = renderCodexGlobalConfig(projectDir, existingGlobal);
  if (existingProject === desiredProject && existingGlobal === desiredGlobal) {
    return { attempted: true, changed: false, fatal: false };
  }

  if (dryRun) {
    if (existingProject !== desiredProject) log(`  ~ codex project config: ${state.projectConfigPath}`);
    if (existingGlobal !== desiredGlobal) log(`  ~ codex global config: ${state.globalConfigPath}`);
    return { attempted: true, changed: true, fatal: false };
  }

  if (!writeConfig(projectDir)) {
    if (cfg.runtime !== 'codex') {
      log('  Warning: failed to refresh codex config outside codex runtime.');
      return { attempted: true, changed: false, fatal: false, warning: true };
    }
    return {
      attempted: true,
      changed: false,
      fatal: true,
      error: 'Failed to refresh codex config.',
    };
  }

  if (existingProject !== desiredProject) log(`  ~ codex project config: ${state.projectConfigPath}`);
  if (existingGlobal !== desiredGlobal) log(`  ~ codex global config: ${state.globalConfigPath}`);
  return { attempted: true, changed: true, fatal: false };
}

/**
 * Sync hooks between template and installed settings (in-memory).
 * Exported for unit testing. Called by main() after loading files.
 *
 * @returns {{ added: number, updated: number, removed: number }}
 */
export function syncHooks(installedSettings, templateSettings, { dryRun = false, log = console.log } = {}) {
  const templateHooks = templateSettings.hooks || {};

  // Collect core skill names from template
  const coreSkillNames = new Set();
  for (const matchers of Object.values(templateHooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      for (const h of getCommandHooks(m)) {
        const name = extractSkillName(h.command);
        if (name) coreSkillNames.add(name);
      }
    }
  }

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Ensure hooks object exists
  if (!installedSettings.hooks) installedSettings.hooks = {};

  // --- Pre-migration: split catch-all matchers into specific matchers ---
  const migrated = migrateMatcherSplit(installedSettings, templateSettings, { dryRun, log });
  if (migrated > 0) {
    updated += migrated;
  }

  const sessionStartMigration = migrateSessionStartOrchestrator(installedSettings, templateSettings, { dryRun, log });
  if (sessionStartMigration.updated > 0) {
    updated += sessionStartMigration.updated;
  }
  const skipEvents = new Set(sessionStartMigration.skipEvents || []);

  // --- Forward pass: add missing matcher groups/hooks, update hooks in matched groups ---
  // Strategy: align by matcher group, not by individual hook across all groups.
  //   - If installed has a group with the same matcher → add missing template
  //     hooks and update existing hooks (command/timeout drift)
  //   - If installed has NO group with that matcher → add the whole group from template
  for (const [event, matchers] of Object.entries(templateHooks)) {
    if (skipEvents.has(event)) continue;
    if (!Array.isArray(matchers)) continue;
    if (!Array.isArray(installedSettings.hooks[event])) {
      installedSettings.hooks[event] = [];
    }
    const installedMatchers = installedSettings.hooks[event];

    for (const templateGroup of matchers) {
      const matcherValue = templateGroup.matcher !== undefined ? templateGroup.matcher : '';
      const installedGroup = installedMatchers.find(g =>
        (g.matcher !== undefined ? g.matcher : '') === matcherValue
      );

      if (installedGroup) {
        // Group exists — add missing template hooks and update existing hooks
        // (command/timeout drift). This is needed for upgrades where new core
        // hooks are added to an existing matcher group.
        for (const templateCmd of getCommandHooks(templateGroup)) {
          const templateKey = extractScriptPath(templateCmd.command);
          const existing = getCommandHooks(installedGroup).find(
            h => extractScriptPath(h.command) === templateKey
          );
          if (!existing) {
            if (!dryRun) {
              if (!Array.isArray(installedGroup.hooks)) installedGroup.hooks = [];
              installedGroup.hooks.push({ ...templateCmd });
            }
            added++;
            log(`  + ${event}[${matcherValue}]: ${templateCmd.command}`);
          } else if (existing.command !== templateCmd.command || existing.timeout !== templateCmd.timeout) {
            if (!dryRun) {
              existing.command = templateCmd.command;
              if (templateCmd.timeout !== undefined) existing.timeout = templateCmd.timeout;
            }
            updated++;
            log(`  ~ ${event}[${matcherValue}]: ${templateCmd.command}`);
          }
        }
      } else {
        // Group missing — add the whole group from template
        if (!dryRun) {
          const newGroup = { hooks: [] };
          if (templateGroup.matcher !== undefined) newGroup.matcher = templateGroup.matcher;
          for (const templateCmd of getCommandHooks(templateGroup)) {
            newGroup.hooks.push({ ...templateCmd });
          }
          installedMatchers.push(newGroup);
        }
        const hookCount = getCommandHooks(templateGroup).length;
        added += hookCount;
        log(`  + ${event}[${matcherValue}]: added matcher group (${hookCount} hooks)`);
      }
    }
  }

  // --- Reverse pass: remove obsolete core hooks (matcher-aware) ---
  // Check each installed group against its corresponding template group (same matcher).
  // A core hook is removed if it's not present in the matching template group,
  // even if it exists in other template groups for the same event.
  for (const [event, matchers] of Object.entries(installedSettings.hooks)) {
    if (skipEvents.has(event)) continue;
    if (!Array.isArray(matchers)) continue;

    const templateMatchers = Array.isArray(templateHooks[event]) ? templateHooks[event] : [];

    for (let gi = matchers.length - 1; gi >= 0; gi--) {
      const group = matchers[gi];
      if (!Array.isArray(group.hooks)) continue;

      const groupMatcher = group.matcher !== undefined ? group.matcher : '';
      const correspondingTemplate = templateMatchers.find(tm =>
        (tm.matcher !== undefined ? tm.matcher : '') === groupMatcher
      );

      for (let hi = group.hooks.length - 1; hi >= 0; hi--) {
        const h = group.hooks[hi];
        if (h.type !== 'command') continue;

        const skillName = extractSkillName(h.command);
        if (!skillName || !coreSkillNames.has(skillName)) continue;

        const installedKey = extractScriptPath(h.command);
        // Check only the corresponding template group, not all groups
        const foundInTemplate = correspondingTemplate
          ? getCommandHooks(correspondingTemplate).some(th => extractScriptPath(th.command) === installedKey)
          : false;

        if (!foundInTemplate) {
          if (!dryRun) {
            group.hooks.splice(hi, 1);
          }
          removed++;
          log(`  - ${event}[${groupMatcher}]: ${h.command}`);
        }
      }

      // Remove empty groups
      if (!dryRun && group.hooks.length === 0) {
        matchers.splice(gi, 1);
      }
    }

    // Clean up empty event arrays
    if (!dryRun && matchers.length === 0) {
      delete installedSettings.hooks[event];
    }
  }

  return { added, updated, removed };
}

/**
 * Enqueue a /exit command so the Claude runtime restarts and loads the new
 * settings.json hooks.  Only acts when the active runtime is Claude and the
 * C4 control script exists.  Failures are non-fatal — the worst case is the
 * user manually restarts.
 */
function enqueueRestartIfNeeded() {
  try {
    const cfg = getZylosConfig();
    if ((cfg.runtime ?? 'claude') !== 'claude') return;

    const c4ControlPath = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
    if (!fs.existsSync(c4ControlPath)) return;

    execFileSync('node', [c4ControlPath, 'enqueue', '--content', '/exit', '--priority', '1', '--block-queue-until-idle', '--no-ack-suffix'], { stdio: 'pipe', timeout: 10000 });
    console.log('Settings hooks: restart enqueued (Claude will reload new configuration).');
  } catch { /* non-fatal */ }
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');

  if (!fs.existsSync(TEMPLATE_SETTINGS)) {
    console.log('Settings hooks: template not found, skipping.');
    return;
  }

  let templateSettings, installedSettings;
  try {
    templateSettings = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS, 'utf8'));
  } catch {
    console.log('Settings hooks: failed to parse template, skipping.');
    return;
  }
  try {
    installedSettings = fs.existsSync(INSTALLED_SETTINGS)
      ? JSON.parse(fs.readFileSync(INSTALLED_SETTINGS, 'utf8'))
      : {};
  } catch {
    installedSettings = {};
  }

  const { added, updated, removed } = syncHooks(installedSettings, templateSettings, { dryRun });

  // --- Sync top-level statusLine from template ---
  let statusLineChanged = false;
  if (templateSettings.statusLine) {
    const tsl = JSON.stringify(templateSettings.statusLine);
    const isl = JSON.stringify(installedSettings.statusLine || null);
    if (tsl !== isl) {
      const symbol = installedSettings.statusLine ? '~' : '+';
      if (!dryRun) {
        installedSettings.statusLine = templateSettings.statusLine;
      }
      statusLineChanged = true;
      console.log(`  ${symbol} statusLine: ${templateSettings.statusLine.command || '(set)'}`);
    }
  } else if (installedSettings.statusLine) {
    // Template removed statusLine — clean up installed copy
    if (!dryRun) {
      delete installedSettings.statusLine;
    }
    statusLineChanged = true;
    console.log(`  - statusLine: (removed)`);
  }

  const modelSync = syncTemplateModelSetting({
    templateSettings,
    installedSettings,
    dryRun,
  });

  // Backfill boolean settings (autoMemoryEnabled, autoDreamEnabled)
  const backfillKeys = ['autoMemoryEnabled', 'autoDreamEnabled'];
  let settingsBackfilled = false;
  for (const key of backfillKeys) {
    const result = syncTemplateSetting(key, {
      templateSettings,
      installedSettings,
      dryRun,
    });
    if (result.changed) settingsBackfilled = true;
  }

  const codexSync = syncCodexConfig({ dryRun });
  if (codexSync.fatal) {
    console.error(codexSync.error);
    process.exit(1);
  }

  if (added === 0 && updated === 0 && removed === 0 && !statusLineChanged && !modelSync.changed && !settingsBackfilled && !codexSync.changed) {
    console.log('Settings hooks: all up to date (no changes).');
    return;
  }

  if (dryRun) {
    console.log(`Settings hooks (dry run): ${added} to add, ${updated} to update, ${removed} to remove${statusLineChanged ? ', statusLine to update' : ''}${modelSync.changed ? ', model to backfill' : ''}${settingsBackfilled ? ', settings to backfill' : ''}${codexSync.changed ? ', codex config to refresh' : ''}.`);
    return;
  }

  // Write settings first. The paired threshold default is written only after
  // the model backfill has persisted, so a crash cannot leave threshold=30
  // without the matching opus[1m] settings model.
  const thresholdSync = persistInstalledSettingsAndSyncCoupledThreshold({
    installedSettings,
    modelBackfilled: modelSync.changed,
  });

  if (added === 0 && updated === 0 && removed === 0 && !statusLineChanged && !modelSync.changed && !settingsBackfilled) {
    console.log(`Settings hooks: all up to date; Codex config ${codexSync.changed ? 'refreshed' : 'unchanged'}.`);
    return;
  }

  console.log(`Settings hooks: ${added} added, ${updated} updated, ${removed} removed${statusLineChanged ? ', statusLine updated' : ''}${modelSync.changed ? ', model backfilled' : ''}${thresholdSync.changed ? ', new-session threshold paired' : ''}${settingsBackfilled ? ', settings backfilled' : ''}${codexSync.changed ? ', Codex config refreshed' : ''}.`);

  // Enqueue restart when hooks changed — this runs from the NEWLY installed
  // package during upgrade (via resolveInstalledSyncScript), so it works even
  // when the calling component.js is an older version without restart logic.
  enqueueRestartIfNeeded();
}

/**
 * Pre-migration: when a template splits a catch-all matcher ("") into specific
 * matchers (e.g. "startup", "clear", "compact"), transform the installed config
 * to match before the forward/reverse passes run.
 *
 * Without this, the forward pass sees the script paths already exist (under "")
 * and skips adding the specific matchers; the reverse pass sees the script paths
 * in the template and keeps the old catch-all. Result: no migration happens.
 *
 * @returns {number} Number of hook entries migrated
 */
export function migrateMatcherSplit(installedSettings, templateSettings, { dryRun = false, log = console.log } = {}) {
  let count = 0;
  const templateHooks = templateSettings.hooks || {};
  const installedHooks = installedSettings.hooks || {};

  for (const [event, templateMatchers] of Object.entries(templateHooks)) {
    if (!Array.isArray(templateMatchers)) continue;
    const installedMatchers = installedHooks[event];
    if (!Array.isArray(installedMatchers)) continue;

    // Find catch-all group in installed config
    const catchAllIdx = installedMatchers.findIndex(g => g.matcher === '' || g.matcher === undefined);
    if (catchAllIdx === -1) continue;

    // Check if template has NO catch-all but has specific matchers
    const templateHasCatchAll = templateMatchers.some(g => g.matcher === '' || g.matcher === undefined);
    if (templateHasCatchAll) continue;

    const templateSpecificMatchers = templateMatchers
      .filter(g => g.matcher !== '' && g.matcher !== undefined)
      .map(g => g.matcher);
    if (templateSpecificMatchers.length === 0) continue;

    // Verify the catch-all hooks match the template hooks (same script paths)
    const catchAllGroup = installedMatchers[catchAllIdx];
    const catchAllPaths = new Set(
      getCommandHooks(catchAllGroup).map(h => extractScriptPath(h.command))
    );
    const templatePaths = new Set(
      templateMatchers.flatMap(g => getCommandHooks(g).map(h => extractScriptPath(h.command)))
    );

    // Only migrate if all catch-all hooks exist in the template
    const allCovered = [...catchAllPaths].every(p => templatePaths.has(p));
    if (!allCovered) continue;

    if (!dryRun) {
      // Replace catch-all with specific matcher groups, preserving hook content
      const hooks = catchAllGroup.hooks || [];
      installedMatchers.splice(catchAllIdx, 1);
      for (const matcher of templateSpecificMatchers) {
        // Only add if this matcher doesn't already exist
        if (!installedMatchers.some(g => g.matcher === matcher)) {
          installedMatchers.push({
            matcher,
            hooks: hooks.map(h => ({ ...h })),
          });
        }
      }
    }

    count += templateSpecificMatchers.length;
    log(`  ↔ ${event}: split catch-all matcher into ${templateSpecificMatchers.join(', ')}`);
  }

  return count;
}

function scriptPathEndsWith(command, suffix) {
  const scriptPath = extractScriptPath(command).split(path.sep).join('/');
  return scriptPath.endsWith(suffix);
}

function isOrchestratorTemplate(templateSettings) {
  const groups = templateSettings?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  const expected = new Set(SESSION_START_MATCHERS);
  if (groups.length !== expected.size) return false;
  for (const group of groups) {
    if (!expected.has(group.matcher)) return false;
    const hooks = getCommandHooks(group);
    if (hooks.length !== 1) return false;
    if (!scriptPathEndsWith(hooks[0].command, 'skills/activity-monitor/scripts/session-start-orchestrator.js')) return false;
  }
  return true;
}

function isStandardOldSessionStartGroup(group) {
  const hooks = getCommandHooks(group);
  if (hooks.length !== SESSION_START_OLD_SCRIPTS.length) return false;
  const seen = new Set();
  for (const hook of hooks) {
    if (hook.type !== 'command') return false;
    const suffix = SESSION_START_OLD_SCRIPTS.find(script => scriptPathEndsWith(hook.command, script));
    if (!suffix || seen.has(suffix)) return false;
    if (hook.timeout !== SESSION_START_OLD_TIMEOUT_BY_SCRIPT.get(suffix)) return false;
    seen.add(suffix);
  }
  return seen.size === SESSION_START_OLD_SCRIPTS.length;
}

function containsOldSessionStartScript(groups) {
  return groups.some(group => getCommandHooks(group).some(h =>
    SESSION_START_OLD_SCRIPTS.some(suffix => scriptPathEndsWith(h.command, suffix))
  ));
}

/**
 * Migrate the standard old SessionStart shape:
 *   startup/clear/compact × [inject, c4-init, foreground, prompt]
 * to:
 *   startup/clear/compact × [orchestrator]
 *
 * Non-standard SessionStart configs are skipped and protected from the generic
 * forward/reverse sync pass, so user-customized running hooks are not silently
 * overwritten during upgrade.
 */
export function migrateSessionStartOrchestrator(installedSettings, templateSettings, { dryRun = false, log = console.log } = {}) {
  if (!isOrchestratorTemplate(templateSettings)) {
    return { updated: 0, skipped: 0, skipEvents: [] };
  }

  const installedGroups = installedSettings?.hooks?.SessionStart;
  if (!Array.isArray(installedGroups) || installedGroups.length === 0) {
    return { updated: 0, skipped: 0, skipEvents: [] };
  }

  const groupsByMatcher = new Map(installedGroups.map(g => [g.matcher ?? '', g]));
  const hasAllStandardGroups = SESSION_START_MATCHERS.every((matcher) =>
    isStandardOldSessionStartGroup(groupsByMatcher.get(matcher))
  );
  const onlyStandardGroups = installedGroups.every(group =>
    SESSION_START_MATCHERS.includes(group.matcher) && isStandardOldSessionStartGroup(group)
  );

  if (!hasAllStandardGroups || !onlyStandardGroups) {
    if (containsOldSessionStartScript(installedGroups)) {
      log('  ! SessionStart: custom/non-standard hooks detected; skipped orchestrator migration');
      return { updated: 0, skipped: 1, skipEvents: ['SessionStart'] };
    }
    return { updated: 0, skipped: 0, skipEvents: [] };
  }

  if (!dryRun) {
    installedSettings.hooks.SessionStart = templateSettings.hooks.SessionStart.map(group => ({
      matcher: group.matcher,
      hooks: getCommandHooks(group).map(h => ({ ...h })),
    }));
  }

  log('  ↔ SessionStart: migrated standard 4-hook groups to orchestrator');
  return { updated: SESSION_START_MATCHERS.length, skipped: 0, skipEvents: ['SessionStart'] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
