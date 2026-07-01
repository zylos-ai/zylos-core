#!/usr/bin/env node
/**
 * Sync settings.json hooks to installed settings.
 *
 * Compares desired runtime hooks with installed hooks by script path:
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
import { hookScriptKey, getCommandHooks } from './hook-utils.js';
import { getZylosConfig, updateZylosConfig } from './config.js';
import { renderCodexProjectConfig, renderCodexGlobalConfig, writeCodexConfig } from './runtime-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZYLOS_DIR = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
const TEMPLATE_SETTINGS = path.join(__dirname, '..', '..', 'templates', '.claude', 'settings.json');
const INSTALLED_SETTINGS = path.join(ZYLOS_DIR, '.claude', 'settings.json');

const MAX_SAFE_1M_THRESHOLD = 30;
export const CORE_MANAGED_HOOKS = new Set([
  // Current template hooks. Keep this append-only: when a core hook is retired,
  // leave its path here so upgrades can still remove stale installed copies.
  'skills/activity-monitor/scripts/context-monitor.js',
  'skills/activity-monitor/scripts/hook-activity.js',
  'skills/activity-monitor/scripts/hook-auth-prompt.js',
  'skills/activity-monitor/scripts/session-start-orchestrator.js',
  // Retired SessionStart hooks replaced by the orchestrator.
  'skills/zylos-memory/scripts/session-start-inject.js',
  'skills/comm-bridge/scripts/c4-session-init.js',
  'skills/activity-monitor/scripts/session-foreground.js',
  'skills/activity-monitor/scripts/session-start-prompt.js',
]);

export function isCoreManaged(hook) {
  if (!hook || hook.type !== 'command') return false;
  return CORE_MANAGED_HOOKS.has(hookScriptKey(hook.command));
}

function zylosClaudeScript(relativePath) {
  const scriptPath = path.resolve(ZYLOS_DIR, '.claude', relativePath);
  return `node ${scriptPath}`;
}

function commandHook(relativePath, options = {}) {
  return {
    type: 'command',
    command: zylosClaudeScript(relativePath),
    ...options,
  };
}

export function desiredClaudeHooks() {
  const sessionStartHook = commandHook(
    'skills/activity-monitor/scripts/session-start-orchestrator.js',
    { timeout: 20000 }
  );
  const activityHook = commandHook(
    'skills/activity-monitor/scripts/hook-activity.js',
    { async: true, timeout: 5 }
  );

  return {
    SessionStart: ['startup', 'clear', 'compact'].map(matcher => ({
      matcher,
      hooks: [{ ...sessionStartHook }],
    })),
    UserPromptSubmit: [
      {
        hooks: [{ ...activityHook }],
      },
    ],
    PreToolUse: [
      {
        matcher: '',
        hooks: [{ ...activityHook }],
      },
    ],
    PermissionRequest: [
      {
        hooks: [
          commandHook(
            'skills/activity-monitor/scripts/hook-auth-prompt.js',
            { async: true, timeout: 5000 }
          ),
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: '',
        hooks: [{ ...activityHook }],
      },
    ],
    PostToolUseFailure: [
      {
        matcher: '',
        hooks: [{ ...activityHook }],
      },
    ],
    Stop: [
      {
        hooks: [{ ...activityHook }],
      },
    ],
    Notification: [
      {
        matcher: 'idle_prompt',
        hooks: [{ ...activityHook }],
      },
    ],
  };
}

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
export function syncHooks(installedSettings, _templateSettings, { dryRun = false, log = console.log, desiredHooks = desiredClaudeHooks() } = {}) {
  const desiredHookGroups = desiredHooks || {};

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Ensure hooks object exists
  if (!installedSettings.hooks) installedSettings.hooks = {};

  // --- Forward pass: add missing matcher groups/hooks, update hooks in matched groups ---
  // Strategy: align by matcher group, not by individual hook across all groups.
  //   - If installed has a group with the same matcher → add missing template
  //     hooks and update existing hooks (command/timeout drift)
  //   - If installed has NO group with that matcher → add the whole group from template
  for (const [event, matchers] of Object.entries(desiredHookGroups)) {
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
          const templateKey = hookScriptKey(templateCmd.command);
          const existing = getCommandHooks(installedGroup).find(
            h => hookScriptKey(h.command) === templateKey
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
    if (!Array.isArray(matchers)) continue;

    const templateMatchers = Array.isArray(desiredHookGroups[event]) ? desiredHookGroups[event] : [];

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

        if (!isCoreManaged(h)) continue;

        const installedKey = hookScriptKey(h.command);
        // Check only the corresponding template group, not all groups
        const foundInTemplate = correspondingTemplate
          ? getCommandHooks(correspondingTemplate).some(th => hookScriptKey(th.command) === installedKey)
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
