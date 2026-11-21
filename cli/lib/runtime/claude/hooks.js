import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateModelThresholds } from '../../model-rotation-thresholds.js';
import { copyPrivateFile, writePrivateFile } from '../../private-file.js';
import { hookScriptKey, getCommandHooks } from '../../hook-utils.js';
import { isCoreManaged, commandHook, desiredSessionStartHooks } from '../../sync-runtime-hooks.js';
import { UNSUPPORTED } from '../contract.js';
import { selectToolInput } from '../shared/tool-input.js';

const ZYLOS_DIR = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
const TEMPLATE_SETTINGS = path.resolve(import.meta.dirname, '../../../..', 'templates/.claude/settings.json');
const INSTALLED_SETTINGS = path.join(ZYLOS_DIR, '.claude', 'settings.json');

export function supportsStopFailureVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/.exec(String(version).trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  // StopFailure was introduced in Claude Code 2.1.78:
  // https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2178
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 78)));
}

export function detectStopFailureSupport({ execFileSyncImpl = execFileSync, binary = process.env.CLAUDE_BIN || 'claude' } = {}) {
  try {
    return supportsStopFailureVersion(execFileSyncImpl(binary, ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 2000 }));
  } catch { return false; }
}

export function supportsSubagentHooksVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/.exec(String(version).trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  // SubagentStart arrived in 2.0.43; register start/stop together.
  // https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2043
  return major > 2 || (major === 2 && (minor > 0 || patch >= 43));
}

export function detectSubagentHooksSupport({ execFileSyncImpl = execFileSync, binary = process.env.CLAUDE_BIN || 'claude' } = {}) {
  try {
    return supportsSubagentHooksVersion(execFileSyncImpl(binary, ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 2000 }));
  } catch { return false; }
}

export function desiredClaudeHooks({
  zylosDir = ZYLOS_DIR,
  existsSync = fs.existsSync,
  stopFailureSupported = false,
  subagentHooksSupported = false,
} = {}) {
  const sessionStartHooks = desiredSessionStartHooks({ zylosDir, existsSync });
  const activityHook = commandHook(
    'skills/activity-monitor/scripts/hook-activity.js',
    { async: true, timeout: 5 }, zylosDir
  );
  const healthHook = commandHook('skills/activity-monitor/scripts/hook-health.js', { async: false, timeout: 5 }, zylosDir);

  return {
    SessionStart: ['startup', 'clear', 'compact'].map(matcher => ({
      matcher,
      // Keep injection entries unchanged; activity is nonblocking and emits no context.
      hooks: [{ ...healthHook }, ...sessionStartHooks.map(hook => ({ ...hook })), { ...activityHook }],
    })),
    UserPromptSubmit: [
      {
        hooks: [{ ...healthHook }, { ...activityHook }],
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
            { async: true, timeout: 5000 }, zylosDir
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
        hooks: [{ ...healthHook }, { ...activityHook }],
      },
    ],
    ...(subagentHooksSupported ? {
      SubagentStart: [{ hooks: [{ ...activityHook }] }],
      SubagentStop: [{ hooks: [{ ...activityHook }] }],
    } : {}),
    ...(stopFailureSupported ? { StopFailure: [{ hooks: [{ ...healthHook }, { ...activityHook }] }] } : {}),
    Notification: [
      {
        matcher: 'idle_prompt',
        hooks: [{ ...activityHook }],
      },
    ],
  };
}

export function syncTemplateModelSetting({
  templateSettings,
  installedSettings,
  dryRun = false,
  log = console.log,
} = {}) {
  if (!Object.hasOwn(templateSettings, 'model') || Object.hasOwn(installedSettings, 'model')) {
    return { changed: false };
  }

  const model = templateSettings.model;

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

export async function syncModelCoupledNewSessionThreshold({
  modelBackfilled = false,
  zylosDir = ZYLOS_DIR,
  cfg,
  defaultModels,
  updateConfig,
  dryRun = false,
  log = console.log,
} = {}) {
  if (!modelBackfilled) return { changed: false, reason: 'model_not_backfilled' };
  const result = await migrateModelThresholds({
    zylosDir, ...(cfg ? { config: cfg } : {}), ...(defaultModels ? { defaultModels } : {}),
    ...(dryRun ? { updateConfig: () => ({ changed: true }) } : { updateConfig }),
  });
  if (result.changed) log('  + model_rotation_thresholds: model defaults migrated');
  return { ...result, ...(!result.changed ? { reason: 'threshold_already_set' } : {}) };
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
  writeFileSync = writePrivateFile,
  existsSync = fs.existsSync,
  copyFileSync = copyPrivateFile,
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
  return syncThreshold({ modelBackfilled, zylosDir: path.dirname(path.dirname(settingsPath)) });
}

/**
 * Sync hooks between template and installed settings (in-memory).
 * Exported for unit testing. Called by main() after loading files.
 *
 * @returns {{ added: number, updated: number, removed: number }}
 */
export function syncHooks(installedSettings, _templateSettings, {
  dryRun = false,
  log = console.log,
  desiredHooks = desiredClaudeHooks(),
  zylosDir = ZYLOS_DIR,
} = {}) {
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
          } else if (existing.command !== templateCmd.command || existing.timeout !== templateCmd.timeout ||
            (Object.hasOwn(templateCmd, 'async') && existing.async !== templateCmd.async)) {
            if (!dryRun) {
              existing.command = templateCmd.command;
              if (templateCmd.timeout !== undefined) existing.timeout = templateCmd.timeout;
              if (Object.hasOwn(templateCmd, 'async')) existing.async = templateCmd.async;
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

        if (!isCoreManaged(h, { zylosDir })) continue;

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

async function sync({
  zylosDir = ZYLOS_DIR,
  dryRun = false,
  stopFailureSupported = detectStopFailureSupport(),
  subagentHooksSupported = detectSubagentHooksSupport(),
  log = console.log,
} = {}) {
  const settingsPath = path.join(zylosDir, '.claude', 'settings.json');

  if (!fs.existsSync(TEMPLATE_SETTINGS)) {
    console.log('Settings hooks: template not found, skipping.');
    return { abort: true };
  }

  let templateSettings, installedSettings;
  try {
    templateSettings = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS, 'utf8'));
  } catch {
    console.log('Settings hooks: failed to parse template, skipping.');
    return { abort: true };
  }
  try {
    installedSettings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      : {};
    if (!installedSettings || typeof installedSettings !== 'object' || Array.isArray(installedSettings) ||
        (installedSettings.hooks !== undefined && (!installedSettings.hooks ||
          typeof installedSettings.hooks !== 'object' || Array.isArray(installedSettings.hooks)))) {
      throw new Error('Expected settings and hooks objects');
    }
  } catch (cause) {
    throw Object.assign(new Error('Cannot read Claude settings for hook synchronization', { cause }), { code: 'SETTINGS_UNREADABLE' });
  }

  const { added, updated, removed } = syncHooks(installedSettings, templateSettings, {
    dryRun, desiredHooks: desiredClaudeHooks({ zylosDir, stopFailureSupported, subagentHooksSupported }),
    zylosDir, log,
  });
  if (!stopFailureSupported) console.log('Health hooks: StopFailure unavailable or unverified; retaining screen-based fallback.');

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

  const changed = added + updated + removed > 0 || statusLineChanged || modelSync.changed || settingsBackfilled;
  return {
    entry: { added, updated, removed },
    changed,
    restart: changed,
    fragments: {
      dryRun: `${added} to add, ${updated} to update, ${removed} to remove${statusLineChanged ? ', statusLine to update' : ''}${modelSync.changed ? ', model to backfill' : ''}${settingsBackfilled ? ', settings to backfill' : ''}`,
      upToDate: '',
    },
    async commit() {
      // Persist the native model first, then pin its per-model threshold.
      // Migration must resolve the model that was actually saved.
      const thresholdSync = await persistInstalledSettingsAndSyncCoupledThreshold({
        installedSettings,
        settingsPath,
        modelBackfilled: modelSync.changed,
      });
      return {
        done: `${added} added, ${updated} updated, ${removed} removed${statusLineChanged ? ', statusLine updated' : ''}${modelSync.changed ? ', model backfilled' : ''}${thresholdSync.changed ? ', new-session threshold paired' : ''}${settingsBackfilled ? ', settings backfilled' : ''}`,
      };
    },
  };
}

function features() {
  return { stopFailure: detectStopFailureSupport(), subagentHooks: detectSubagentHooksSupport() };
}

async function ready({ zylosDir }) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(zylosDir, '.claude', 'settings.json'), 'utf8'));
    const copy = structuredClone(settings);
    const changes = syncHooks(copy, null, { zylosDir, dryRun: true, log: () => {},
      desiredHooks: desiredClaudeHooks({ stopFailureSupported: detectStopFailureSupport(), subagentHooksSupported: detectSubagentHooksSupport() }) });
    return changes.added + changes.updated + changes.removed === 0;
  } catch { return false; }
}

function stage(settings, { zylosDir, existsSync, stopFailureSupported, subagentHooksSupported, templateSettings, cfg }) {
  const stopFailure = stopFailureSupported ?? detectStopFailureSupport();
  const subagentHooks = subagentHooksSupported ?? detectSubagentHooksSupport();
  syncHooks(settings, {}, { zylosDir, log: () => {},
    desiredHooks: desiredClaudeHooks({ zylosDir, existsSync, stopFailureSupported: stopFailure, subagentHooksSupported: subagentHooks }) });
  if (templateSettings.statusLine) settings.statusLine = templateSettings.statusLine;
  else delete settings.statusLine;
  syncTemplateModelSetting({ templateSettings, installedSettings: settings, cfg, log: () => {} });
  for (const key of ['autoMemoryEnabled', 'autoDreamEnabled']) {
    syncTemplateSetting(key, { templateSettings, installedSettings: settings, log: () => {} });
  }
  return settings;
}

export const hooks = Object.freeze({
  sessionIdEnv: 'CLAUDE_SESSION_ID',
  sync,
  syncPolicy: 'always',
  optedIn: UNSUPPORTED,
  ready,
  trust: UNSUPPORTED,
  features,
  stage,
  writeConfig: UNSUPPORTED,
  installHooks: UNSUPPORTED,
  normalize: payload => payload,
  output: ({ event, result }) => event === 'SessionStart' && typeof result?.text === 'string' ? result.text : '',
  toolInput: selectToolInput,
  mainSession: UNSUPPORTED,
  readSessionSource: UNSUPPORTED,
  toolGuard: UNSUPPORTED,
});
