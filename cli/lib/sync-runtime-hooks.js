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
import { hookScriptKey, hookScriptBaseKey, HOOK_ENTRY_SCRIPT } from './hook-utils.js';
import { getRuntime, runtimeDisplayName, SUPPORTED_RUNTIMES } from './runtime/index.js';
import {
  SIDE_EFFECT_NAMES,
  buildChain,
} from '../../skills/activity-monitor/scripts/shard-registry.js';

const ZYLOS_DIR = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));

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

/**
 * Every core hook runs through the hook entry, which lets only the run's pane
 * main process reach the target script. `exec` replaces the runtime's shell,
 * so the entry's parent is the runtime itself.
 */
export function hookEntryCommand(targetPath, zylosDir = ZYLOS_DIR, { quote = false } = {}) {
  const entry = path.resolve(zylosDir, '.claude', HOOK_ENTRY_SCRIPT);
  const word = value => quote ? JSON.stringify(value) : value;
  return `exec node ${word(entry)} ${word(targetPath)}`;
}

export function zylosClaudeScript(relativePath, zylosDir = ZYLOS_DIR) {
  return hookEntryCommand(path.resolve(zylosDir, '.claude', relativePath), zylosDir);
}

export function commandHook(relativePath, options = {}, zylosDir = ZYLOS_DIR) {
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
 * Five core shards followed by any component shards declared under
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
      hookEntryCommand(path.join(instructionsDir, 'assembler.mjs'), root, { quote: true }),
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

/** Generation is separate from restart submission so upgrade can call it after its deadline gate. */
export async function enqueueRestartIfNeeded({
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
  } catch (error) {
    errorLog(`Settings hooks: restart not enqueued: ${error.code || 'ERROR'}: ${error.message}`);
    return { submitted: false, code: error.code || 'ERROR' };
  }

}

export async function syncRuntimeHooks(options = {}) {
  const runtimes = await Promise.all(SUPPORTED_RUNTIMES.map(getRuntime));
  const reports = [];
  let aborted = false;
  for (const rt of runtimes.filter(rt => rt.hooks.syncPolicy === 'always')) {
    const report = await rt.hooks.sync(options);
    if (report.abort) {
      aborted = true;
      break;
    }
    reports.push([rt.id, report]);
  }

  let result;
  if (!aborted) {
    const entries = Object.fromEntries(reports.map(([id, report]) => [id, report.entry]));
    const changed = reports.some(([, report]) => report.changed);
    const restart = reports.some(([, report]) => report.restart);
    if (!changed) {
      console.log('Settings hooks: all up to date (no changes).');
      result = { ...entries, changed: false };
    } else if (options.dryRun) {
      const fragments = reports.map(([, report]) => report.fragments.dryRun).join('');
      console.log(`Settings hooks (dry run): ${fragments}.`);
      result = { ...entries, changed: true };
    } else {
      for (const [, report] of reports) {
        const committed = await report.commit?.();
        if (committed) report.fragments.done = committed.done;
      }
      if (!restart) {
        const fragments = reports.map(([, report]) => report.fragments.upToDate).filter(Boolean).join('; ');
        console.log(`Settings hooks: all up to date; ${fragments}.`);
      } else {
        const fragments = reports.map(([, report]) => report.fragments.done).join('');
        console.log(`Settings hooks: ${fragments}.`);
      }
      result = { ...entries, changed: restart };
    }
  }

  for (const rt of runtimes.filter(rt => rt.hooks.syncPolicy === 'opted-in')) {
    let entry = { changed: false };
    if (rt.hooks.optedIn({ home: undefined })) {
      try {
        entry = await rt.hooks.sync({ zylosDir: options.zylosDir || ZYLOS_DIR, dryRun: options.dryRun || false });
      } catch (error) {
        entry.error = { code: error.code || 'AGY_CONFIG_SYNC_FAILED', message: error.message };
        console.error(`${runtimeDisplayName(rt.id)} configuration: ${entry.error.message}`);
      }
    }
    if (result) result[rt.id] = entry;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const result = await syncRuntimeHooks({ dryRun });
  if (!dryRun && result?.changed) await enqueueRestartIfNeeded();
}
