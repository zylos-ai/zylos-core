#!/usr/bin/env node
/**
 * C4 Communication Bridge - Session Init
 * Called by session start hook. Outputs context prompt for Claude Code as
 * uniform `=== LABEL ===` blocks (see session-format.js), shared with the
 * memory injection step so the combined session-start context reads
 * consistently:
 * Emits the current scope's delivered tail and on-demand memory pointers.
 *
 * Usage: node c4-session-init.js
 */

let logHookTiming=()=>{},formatSection,withinBudget;
async function normalHelpers(){
 if(formatSection)return;
 const [diagnostic,format,registry]=await Promise.all([import('./c4-diagnostic.js'),import('./session-format.js'),import('../../activity-monitor/scripts/shard-registry.js')]);
 logHookTiming=diagnostic.logHookTiming;formatSection=format.formatSection;withinBudget=registry.withinBudget;
}
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { bootstrapScope, loadCoreModule } from '../../activity-monitor/scripts/bootstrap-scope.js';
import { isSubsession } from '../../activity-monitor/scripts/bootstrap-identity.js';
const require=createRequire(import.meta.url);

// Ordinary entrypoints only consult the explicit active marker. Historical
// transactions are inspected by upgrade admission and explicit recovery tools.
function hasRecoveryMaterials(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    for (const relative of ['.zylos', '.zylos/upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    return !!present(path.join(root, '.zylos/upgrade/active.json'));
  } catch { return true; }
}

function recoveryContext() {
  try {
    const root = fs.realpathSync(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
    if (!hasRecoveryMaterials(root)) return null;
    const directory = path.join(root, '.zylos', 'upgrade');
    const entry = path.join(directory, 'bootstrap.cjs');
    for (const parent of [path.join(root, '.zylos'), directory]) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw Error('untrusted stable upgrade discovery directory');
      }
    }
    for (const [file, isDirectory] of [
      [directory, true],
      ...['bootstrap.cjs', 'maintenance.cjs'].map(name => [path.join(directory, name), false]),
    ]) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) {
        throw Error('untrusted stable upgrade discovery material');
      }
    }
    const context = require(entry).bootstrap(root);
    return context.active ? context : null;
  } catch {
    return {
      active: true, blocked: true, recovery_required: true,
      prompt: 'SYSTEM RECOVERY TASK: Upgrade discovery failed. Keep normal C4/database access isolated. Use only the fixed file-only upgrade status entry after verifying its ownership and permissions. Preserve transaction materials; report recovery_required if trusted discovery remains unavailable. Do not query C4 or execute journal command strings.',
    };
  }
}

function recoveryBlock(context) {
  return `=== UPGRADE RECOVERY TASK ===\n${context.prompt}\n=== END UPGRADE RECOVERY TASK ===`;
}

function needsRecoveryCue(context) {
  return context && (context.blocked || !context.controllerAlive);
}

async function withC4Db(label, action) {
  const recovery = recoveryContext();
  const cue = needsRecoveryCue(recovery) ? recoveryBlock(recovery) : '';
  if (recovery?.blocked) return cue;
  let close = () => {};
  try {
    await normalHelpers();
    const db = await import('./c4-db.js');
    close = db.close;
    const normal = await action(db);
    return cue ? [normal, cue].filter(Boolean).join('\n\n') : normal;
  } catch (err) {
    const wrapped = new Error(`Error in ${label}: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  } finally {
    close();
  }
}

/** Keep original message bytes and drop whole oldest messages to fit. */
export async function emitC4Conversations(payload, budget = null, {
  scopeReader = bootstrapScope, withDb = withC4Db,
  migrationReader = async scope => {
    const record = path.join(scope.root, '.zylos/migrations/references-layout-v1.json');
    try { fs.lstatSync(record); }
    catch (error) { if (error.code === 'ENOENT') return { state: 'absent' }; throw error; }
    const { createMigration } = await loadCoreModule('memory-migration.js');
    return createMigration({ env: { ...process.env, ZYLOS_DIR: scope.root } }).status();
  },
} = {}) {
  const scope = await scopeReader();
  return withDb('c4 conversations init', async db => {
    await normalHelpers();
    const coverage = scope.mode === 'multi' ? db.getCoverageEnd(scope.sessionGroup) : db.getGlobalCoverageEnd();
    const conversations = scope.mode === 'multi'
      ? db.getDeliveredSince(scope.sessionGroup, coverage, { limit: 6 })
      : db.getGlobalDeliveredSince(coverage, { limit: 6 });
    const instructions = [
      `Scope: ${scope.scope}. Working memory is not injected. Read the complete snapshot with: node ${path.join(scope.root, '.claude/skills/zylos-memory/scripts/read-work-memory.js')} --json`,
      `Before resuming work, read ${path.join(scope.memoryDir, 'handoff.md')} in full, using successive file ranges when needed. Reading does not consume it; retain unfinished items.`,
    ];
    if (!isSubsession(payload) && (scope.scope === '*' || scope.scope === 'origin')) {
      try {
        const migration = await migrationReader(scope);
        if (migration.state === 'pending') instructions.push('References migration is pending. Use memory-migration.js status, then follow the references-layout migration instructions; this does not block READY.');
        else if (migration.state === 'unreadable') instructions.push('References migration record UNAVAILABLE; do not overwrite it.');
      } catch { instructions.push('References migration record UNAVAILABLE; do not overwrite it.'); }
    }
    const assemble = rows => formatSection('RECENT CONVERSATIONS', instructions.join('\n') + '\n\n' + db.formatConversationsForAgent(rows, { spill: false }));
    let kept = conversations;
    const packBudget = budget && { maxChars: Math.max(0, budget.maxChars - 200), maxTokens: Math.max(0, budget.maxTokens - 60) };
    while (kept.length && packBudget && !withinBudget(assemble(kept), packBudget)) kept = kept.slice(1);
    return assemble(kept);
  });
}

export async function initC4Session() {
  try {
    const recovery = recoveryContext();
    if (recovery?.blocked) return needsRecoveryCue(recovery) ? recoveryBlock(recovery) + '\n' : '';
    const sections = [await emitC4Conversations()].filter(Boolean);
    return `${sections.join('\n\n')}\n`;
  } catch (err) {
    if (err.cause) throw err;
    const wrapped = new Error(`Error in session init: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

function main() {
  const startMs = Date.now();
  (async () => {
    try {
      process.stdout.write(await initC4Session());
    } catch (err) {
      console.error(err.cause?.stack || err.stack || err.message);
      process.exitCode = 1;
    } finally {
      logHookTiming('c4-session-init', Date.now() - startMs);
    }
  })().catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exitCode = 1;
    logHookTiming('c4-session-init', Date.now() - startMs);
  });
}

// The module URL is canonicalized by Node, while argv may retain a macOS
// /var alias (or another directory symlink). Recovery cues must still run.
function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) {
  main();
}
