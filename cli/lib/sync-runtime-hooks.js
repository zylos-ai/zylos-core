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
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { hookScriptKey, hookScriptBaseKey, getCommandHooks } from './hook-utils.js';
import { getZylosConfig, readSessionMode, updateZylosConfigLocked } from './config.js';
import { renderCodexProjectConfig, renderCodexGlobalConfig, writeCodexConfig, resolveCodexBypassPermissions } from './runtime-setup.js';
import { installCoreCodexHook } from './codex-hooks.js';
import {
  SIDE_EFFECT_NAMES,
  buildChain,
  loadComponentShardDeclarations,
} from '../../skills/activity-monitor/scripts/shard-registry.js';

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
  'skills/activity-monitor/scripts/hook-health.js',
  'skills/activity-monitor/scripts/hook-auth-prompt.js',
  'skills/activity-monitor/scripts/session-start-orchestrator.js',
  // Retired SessionStart hooks replaced by the orchestrator.
  'skills/zylos-memory/scripts/session-start-inject.js',
  'skills/comm-bridge/scripts/c4-session-init.js',
  'skills/activity-monitor/scripts/session-foreground.js',
  'skills/activity-monitor/scripts/session-start-prompt.js',
]);

export function isCoreManaged(hook, { zylosDir = ZYLOS_DIR } = {}) {
  // Base key (shard-arg stripped): every --shard variant of a core-managed
  // script is core-managed, and the retired no-arg orchestrator command keys
  // to the same path so upgrades sweep it out.
  if (!hook || hook.type !== 'command') return false;
  const key = hookScriptBaseKey(hook.command);
  return CORE_MANAGED_HOOKS.has(key)
    || key === path.resolve(zylosDir, '.zylos', 'instructions', 'assembler.mjs').replaceAll('\\', '/');
}

function zylosClaudeScript(relativePath, zylosDir = ZYLOS_DIR) {
  const scriptPath = path.resolve(zylosDir, '.claude', relativePath);
  return `node ${scriptPath}`;
}

function commandHook(relativePath, options = {}, zylosDir = ZYLOS_DIR) {
  return {
    type: 'command',
    command: zylosClaudeScript(relativePath, zylosDir),
    ...options,
  };
}

/**
 * One SessionStart hook command per injection shard (plus the two
 * side-effect steps), all running the orchestrator script with distinct
 * `--shard` args. Chain membership and order come from the shard registry:
 * Four core shards followed by any component shards declared under
 * ~/zylos/.zylos/shards.d/.
 */
export function desiredSessionStartHooks({
  zylosDir = ZYLOS_DIR,
  existsSync = fs.existsSync,
} = {}) {
  const { chain } = buildChain({ zylosDir });
  const names = [
    ...chain.map(shard => shard.name),
    SIDE_EFFECT_NAMES.foreground,
    SIDE_EFFECT_NAMES.startPrompt,
  ];
  const orchestrator = zylosClaudeScript('skills/activity-monitor/scripts/session-start-orchestrator.js', zylosDir);
  const instructionsDir = path.resolve(zylosDir, '.zylos', 'instructions');
  const assembler = path.join(instructionsDir, 'assembler.mjs');
  const assemblerHook = canonicalAssemblerEntry({ zylosDir });
  const hooks = names.map(name => ({
    type: 'command',
    command: `${orchestrator} --shard ${name}`,
    timeout: 20000,
  }));
  // postinstall can run before `zylos init` materializes the assembler.
  // Do not publish a hook that cannot execute; init syncs again after deploy.
  return existsSync(assembler) ? [assemblerHook, ...hooks] : hooks;
}

export function canonicalAssemblerEntry({ zylosDir = ZYLOS_DIR } = {}) {
  const root = path.resolve(zylosDir);
  const instructionsDir = path.join(root, '.zylos', 'instructions');
  return {
    type: 'command',
    command: [
      'node', JSON.stringify(path.join(instructionsDir, 'assembler.mjs')),
      '--marker', JSON.stringify(path.join(instructionsDir, 'meta.json')),
      '--system', JSON.stringify(path.join(instructionsDir, 'claude-system.md')),
      '--user', JSON.stringify(path.join(root, 'ZYLOS.md')),
      '--output', JSON.stringify(path.join(root, 'CLAUDE.md')),
    ].join(' '),
    timeout: 20000,
  };
}

/**
 * Pure in-memory seam owned by the canonical hook generator. It only creates
 * or repairs the three assembler entries; callers own schema preflight,
 * anomaly refusal, ordering and persistence.
 */
export function reconcileAssemblerEntries(settings, { zylosDir = ZYLOS_DIR } = {}) {
  const canonical = canonicalAssemblerEntry({ zylosDir });
  const canonicalKey = hookScriptKey(canonical.command);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  let changed = false;
  for (const matcher of ['startup', 'clear', 'compact']) {
    let group = settings.hooks.SessionStart.find(item => (item.matcher ?? '') === matcher);
    if (!group) {
      group = { matcher, hooks: [] };
      settings.hooks.SessionStart.push(group);
      changed = true;
    }
    if (!group.hooks) {
      group.hooks = [];
      changed = true;
    }
    const entry = group.hooks.find(hook => (
      typeof hook.command === 'string' && hookScriptKey(hook.command) === canonicalKey
    ));
    if (!entry) {
      group.hooks.push({ ...canonical });
      changed = true;
      continue;
    }
    if (entry.command !== canonical.command) {
      entry.command = canonical.command;
      changed = true;
    }
    if (entry.timeout !== canonical.timeout) {
      entry.timeout = canonical.timeout;
      changed = true;
    }
  }
  return { settings, changed };
}

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

export function desiredClaudeHooks({
  zylosDir = ZYLOS_DIR,
  existsSync = fs.existsSync,
  stopFailureSupported = false,
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
      hooks: [{ ...healthHook }, ...sessionStartHooks.map(hook => ({ ...hook }))],
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
    ...(stopFailureSupported ? { StopFailure: [{ hooks: [{ ...healthHook }] }] } : {}),
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
  cfg,
  updateConfig = updateZylosConfigLocked,
  dryRun = false,
  log = console.log,
} = {}) {
  if (!modelBackfilled) {
    return { changed: false, reason: 'model_not_backfilled' };
  }

  if (dryRun) {
    cfg ??= getZylosConfig();
    if (Object.hasOwn(cfg, 'new_session_threshold')) {
      return { changed: false, reason: 'threshold_already_set' };
    }
  } else {
    const result = updateConfig({ setIfAbsent: { new_session_threshold: 30 } });
    if (!result.changed) return { changed: false, reason: 'threshold_already_set' };
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

export function syncCodexConfig({
  dryRun = false,
  projectDir = ZYLOS_DIR,
  homeDir = os.homedir(),
  readFileSync = fs.readFileSync,
  writeConfig = writeCodexConfig,
  onWrite,
  log = console.log,
} = {}) {
  const globalConfigPath = path.join(homeDir, '.codex', 'config.toml');
  const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');

  // Check both project-level and global config for drift
  let existingGlobal = '';
  try { existingGlobal = readFileSync(globalConfigPath, 'utf8'); } catch {}
  let existingProject = '';
  try { existingProject = readFileSync(projectConfigPath, 'utf8'); } catch {}

  let desiredProject;
  try {
    const bypassPermissions = resolveCodexBypassPermissions(projectDir);
    desiredProject = renderCodexProjectConfig(existingProject, { bypassPermissions });
  } catch {
    const error = 'Failed to refresh Codex project config: check TOML syntax and deployment environment.';
    log(`  Warning: ${error}`);
    return { attempted: true, changed: false, fatal: true, error };
  }
  const desiredGlobal = renderCodexGlobalConfig(projectDir, existingGlobal);
  if (existingProject === desiredProject && existingGlobal === desiredGlobal) {
    return { attempted: true, changed: false, fatal: false };
  }

  if (dryRun) {
    if (existingProject !== desiredProject) log(`  ~ codex project config: ${projectConfigPath}`);
    if (existingGlobal !== desiredGlobal) log(`  ~ codex global config: ${globalConfigPath}`);
    return { attempted: true, changed: true, fatal: false };
  }

  if (!writeConfig(projectDir, { onWrite })) {
    return {
      attempted: true,
      changed: false,
      fatal: true,
      error: 'Failed to refresh codex config.',
    };
  }

  if (existingProject !== desiredProject) log(`  ~ codex project config: ${projectConfigPath}`);
  if (existingGlobal !== desiredGlobal) log(`  ~ codex global config: ${globalConfigPath}`);
  return { attempted: true, changed: true, fatal: false };
}

/**
 * Legacy SessionStart hook paths that component shard declarations claim for
 * removal (shard-registry.js documents the declaration contract). This is the
 * ONLY channel through which sync removes hooks it does not own: a component
 * may claim its own old hook paths (relative to ~/zylos/.claude, enforced at
 * declaration validation), and everything unclaimed — user hooks, undeclared
 * component hooks, anything outside the zylos .claude root — is preserved.
 */
export function claimedHookBaseKeys({ zylosDir = ZYLOS_DIR } = {}) {
  const { declarations } = loadComponentShardDeclarations({ zylosDir });
  return new Set(declarations.flatMap(declaration => declaration.claimHooks));
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
  claimedKeys = claimedHookBaseKeys(),
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

        // Claims only ever apply to SessionStart (the shard chain's event)
        // and only via relative-to-.claude keys, so hooks outside the zylos
        // root can never match a claim.
        const claimed = event === 'SessionStart'
          && claimedKeys.size > 0
          && claimedKeys.has(hookScriptBaseKey(h.command));
        if (!isCoreManaged(h, { zylosDir }) && !claimed) continue;

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
          log(`  - ${event}[${groupMatcher}]: ${h.command}${claimed && !isCoreManaged(h, { zylosDir }) ? ' (claimed by component shard declaration)' : ''}`);
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

/** Generation is separate from restart submission so upgrade can call it after its deadline gate. */
export async function enqueueRestartIfNeeded({
  readMode = readSessionMode,
  readTransition = async () => (await import('../../skills/comm-bridge/scripts/c4-db.js')).getModeTransition(),
  exec = execFileSync,
  exists = fs.existsSync,
  zylosDir = ZYLOS_DIR,
  log = console.log,
  errorLog = console.error,
  submitRestart = async (...args) => (await import('./am-sock-client.js')).submit(...args),
  lookupRestart = async (...args) => (await import('./am-sock-client.js')).lookupRestartRequest(...args),
  now = Date.now,
  requestId = () => `upgrade-${now()}-${randomBytes(6).toString('hex')}`,
  deadlineAt,
} = {}) {
  const deadline = deadlineAt ?? now() + 10000;
  try {
    const mode = readMode().mode ?? 'single';
    const transition = await readTransition();
    if (mode === 'multi' || transition) {
      if (!Number.isSafeInteger(deadline)) throw Object.assign(new Error('Invalid restart deadline'), { code: 'INVALID_INPUT' });
      if (now() >= deadline) {
        errorLog('Settings hooks: restart not submitted: deadline_exceeded');
        return { submitted: false, code: 'deadline_exceeded', sent: false, category: 'T', persisted: [] };
      }
      const request = { version: 1, type: 'restart_all', requestId: requestId(), reason: 'upgrade' };
      const outcome = await submitRestart(request, { deadlineAt: deadline, replyMaxMs: 10000,
        socketPath: path.join(zylosDir, 'activity-monitor', 'am.sock') });
      const kind = outcome.kind;
      if (['accepted', 'rejected'].includes(kind)) {
        if (kind === 'accepted') {
          log(`Settings hooks: restart ${outcome.reply.result} (${outcome.reply.runCount} runs); readiness is not confirmed.`);
          return { submitted: true, requestId: request.requestId, result: outcome.reply.result, runCount: outcome.reply.runCount };
        } else {
          const code = outcome.reply.code;
          if (code === 'single_mode') {
            const currentMode = readMode().mode ?? 'single';
            const currentTransition = await readTransition();
            if (currentMode === 'single' && !currentTransition) {
              return enqueueSingleRestart();
            }
          }
          errorLog(`Settings hooks: restart rejected: ${code}`);
          return { submitted: false, requestId: request.requestId, code, sent: true,
            category: ['manual_restart_pending', 'entry_not_open'].includes(code) ? 'T' : 'R', persisted: [] };
        }
      }
      if (outcome?.sent === false && ['connect_failed', 'deadline_exceeded'].includes(kind)) {
        errorLog(`Settings hooks: restart not submitted: ${kind}`);
        return { submitted: false, requestId: request.requestId, code: kind, sent: false, category: 'T', persisted: [] };
      }
      let lookup = 'unknown';
      try { lookup = await lookupRestart(request.requestId, { deadlineAt: deadline }); }
      catch { /* Preserve uncertainty when the readback itself fails. */ }
      errorLog(`Settings hooks: restart result uncertain (${kind || 'invalid_reply'}); lookup: ${lookup}; no resubmission.`);
      return { submitted: ['accepted', 'done'].includes(lookup) ? true : null,
        requestId: request.requestId, code: kind || 'invalid_reply', sent: true, category: 'U', persisted: null, lookup };
    }
    return enqueueSingleRestart();
  } catch (error) {
    errorLog(`Settings hooks: restart not enqueued: ${error.code || 'ERROR'}: ${error.message}`);
    return { submitted: false, code: error.code || 'ERROR' };
  }

  function enqueueSingleRestart() {
    const c4ControlPath = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
    if (!exists(c4ControlPath)) return { skipped: true, reason: 'control_missing' };
    exec('node', [c4ControlPath, 'enqueue', '--content', '/exit', '--priority', '1', '--require-idle', '--no-ack-suffix'], { stdio: 'pipe', timeout: 10000 });
    log('Settings hooks: restart enqueued.');
    return { submitted: true };
  }
}

export function syncRuntimeHooks({
  zylosDir = ZYLOS_DIR,
  dryRun = false,
  stopFailureSupported = detectStopFailureSupport(),
  log = console.log,
} = {}) {
  const settingsPath = path.join(zylosDir, '.claude', 'settings.json');

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
    dryRun, desiredHooks: desiredClaudeHooks({ zylosDir, stopFailureSupported }),
    claimedKeys: claimedHookBaseKeys({ zylosDir }), zylosDir, log,
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

  const codexSync = syncCodexConfig({ dryRun, projectDir: zylosDir });
  if (codexSync.fatal) {
    console.error(codexSync.error);
    throw new Error(codexSync.error);
  }

  // Hook membership can change independently of either TOML file.
  const codexHooks = dryRun ? { changed: false } : installCoreCodexHook({ zylosDir });
  const result = { claude: { added, updated, removed }, codex: codexHooks, stopFailureSupported };

  if (added === 0 && updated === 0 && removed === 0 && !statusLineChanged && !modelSync.changed && !settingsBackfilled && !codexSync.changed && !codexHooks.changed) {
    console.log('Settings hooks: all up to date (no changes).');
    return { ...result, changed: false };
  }

  if (dryRun) {
    console.log(`Settings hooks (dry run): ${added} to add, ${updated} to update, ${removed} to remove${statusLineChanged ? ', statusLine to update' : ''}${modelSync.changed ? ', model to backfill' : ''}${settingsBackfilled ? ', settings to backfill' : ''}${codexSync.changed ? ', codex config to refresh' : ''}.`);
    return { ...result, changed: true };
  }

  // Write settings first. The paired threshold default is written only after
  // the model backfill has persisted, so a crash cannot leave threshold=30
  // without the matching opus[1m] settings model.
  const thresholdSync = persistInstalledSettingsAndSyncCoupledThreshold({
    installedSettings,
    settingsPath,
    modelBackfilled: modelSync.changed,
  });

  if (added === 0 && updated === 0 && removed === 0 && !statusLineChanged && !modelSync.changed && !settingsBackfilled && !codexHooks.changed) {
    console.log(`Settings hooks: all up to date; Codex config ${codexSync.changed ? 'refreshed' : 'unchanged'}.`);
    return { ...result, changed: false };
  }

  console.log(`Settings hooks: ${added} added, ${updated} updated, ${removed} removed${statusLineChanged ? ', statusLine updated' : ''}${modelSync.changed ? ', model backfilled' : ''}${thresholdSync.changed ? ', new-session threshold paired' : ''}${settingsBackfilled ? ', settings backfilled' : ''}${codexSync.changed ? ', Codex config refreshed' : ''}${codexHooks.changed ? ', Codex hooks refreshed' : ''}.`);

  return { ...result, changed: true };
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const result = syncRuntimeHooks({ dryRun });
  if (!dryRun && result?.changed) await enqueueRestartIfNeeded();
}
