#!/usr/bin/env node
/**
 * C4 Communication Bridge - Session Init
 * Called by session start hook. Outputs context prompt for Claude Code as
 * uniform `=== LABEL ===` blocks (see session-format.js), shared with the
 * memory injection step so the combined session-start context reads
 * consistently:
 * - Last checkpoint (summary if present, else a `(no summary …)` fallback so
 *   the block never silently disappears when a checkpoint has a null summary)
 * - Unsummarized conversations (all if ≤ threshold, last N if > threshold)
 * - Memory Sync instruction (only if > threshold)
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
const require=createRequire(import.meta.url);

function hasRecoveryMaterials(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    for (const relative of ['.zylos', '.zylos/upgrade', '.backup', '.backup/self-upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' && relative !== '.backup' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    for (const relative of ['.zylos/upgrade/active.json']) {
      if (present(path.join(root, relative))) return true;
    }
    const active = path.join(root, '.backup/self-upgrade');
    return !!present(active) && fs.readdirSync(active).length > 0;
  } catch {
    return true;
  }
}
function recoveryContext() {
  try {
    const root = fs.realpathSync(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
    if (!hasRecoveryMaterials(root)) return null;
    const directory = path.join(root, '.zylos', 'upgrade');
    const entry = path.join(directory, 'bootstrap.cjs');
    for (const [parent, shared] of [[path.join(root, '.zylos'), true], [directory, false]]) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          (process.getuid && stat.uid !== process.getuid()) || (!shared && (stat.mode & 0o022))) {
        throw Error('untrusted stable upgrade discovery directory');
      }
    }
    for (const [file, isDirectory] of [
      [directory, true],
      ...['bootstrap.cjs', 'maintenance.cjs'].map(name => [path.join(directory, name), false]),
    ]) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
          (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
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
  // Checkpoint owns the fallback cue. Conversation shard only suppresses C4,
  // preventing three copies across initial prompt and the two C4 shards.
  const cue = label === 'c4 checkpoint init' && needsRecoveryCue(recovery)
    ? recoveryBlock(recovery) : '';
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

/**
 * Emit the last-checkpoint section, or '' when no checkpoint exists yet.
 * Standalone emitter for the session-start shard orchestrator; also composed
 * into initC4Session() for the legacy single-stdout path.
 */
export async function emitC4Checkpoint() {
  return withC4Db('c4 checkpoint init', ({ getLastCheckpoint }) => {
    const checkpoint = getLastCheckpoint();

    // Always surface the last checkpoint. Summary present → show it; summary
    // null → emit a fallback so the block never silently disappears.
    if (!checkpoint) return '';
    if (checkpoint.summary) {
      return formatSection('LAST CHECKPOINT SUMMARY', checkpoint.summary);
    }
    return formatSection(
      'LAST CHECKPOINT',
      `(no summary — checkpoint #${checkpoint.id}, ${checkpoint.timestamp})`,
    );
  });
}

/**
 * Emit the unsummarized-conversations section (including the "no new
 * conversations" fallback and, above threshold, the Memory Sync instruction).
 *
 * In shard mode the orchestrator passes the shard's budget, and messages are
 * emitted as ORIGINAL content — never the dispatch-style preview + attachment
 * pointer (#724): the DB stores originals, and compressing them at session
 * start would make the agent's own recent history lossy while budget room
 * goes unused. Over-budget output is packed at MESSAGE granularity instead:
 * whole oldest messages are dropped until the newest ones fit inline. This
 * shard must never rely on the generic tail-trim + spill fallback — that
 * would cut the NEWEST messages (the text is chronological) and depend on
 * the agent following a read-this-file pointer. Dropped messages are not
 * lost: Memory Sync reads c4.db directly, so they are covered by the next
 * checkpoint summary. Only when a SINGLE message alone overflows the whole
 * shard budget does that message fall back to the preview + pointer form —
 * a compressed newest message plus intact section structure beats the
 * orchestrator's blind tail-trim. Without a budget (legacy single-stdout
 * path, no packer to bound the output) behavior is unchanged: per-message
 * spill applies as before and the output is byte-identical to before.
 */
export async function emitC4Conversations(_payload, budget = null) {
  return withC4Db('c4 conversations init', async ({
    getUnsummarizedRange,
    getUnsummarizedConversations,
    formatConversationsForAgent,
  }) => {
    const { CHECKPOINT_THRESHOLD, SESSION_INIT_RECENT_COUNT } = await import('./c4-config.js');

    const range = getUnsummarizedRange();
    if (range.count === 0) {
      return formatSection('RECENT CONVERSATIONS', 'No new conversations since last checkpoint.');
    }

    const needsSync = range.count > CHECKPOINT_THRESHOLD;

    // Get conversations: all if under threshold, last N if over
    const conversations = needsSync
      ? getUnsummarizedConversations(SESSION_INIT_RECENT_COUNT)
      : getUnsummarizedConversations();

    const assemble = (kept, { spill = true } = {}) => {
      // Informational only — no file to read. Kept within the section so it
      // survives exactly as long as the section does.
      const note = kept.length < conversations.length
        ? `(showing the newest ${kept.length} of ${range.count} unsummarized messages inline; older ones are covered by the next Memory Sync checkpoint)\n\n`
        : '';
      const sections = [formatSection('RECENT CONVERSATIONS', note + formatConversationsForAgent(kept, { spill }))];

      // If over threshold, append Memory Sync instruction
      if (needsSync) {
        sections.push(formatSection(
          'ACTION REQUIRED',
          `There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`,
        ));
      }

      return sections.join('\n\n');
    };

    // Legacy single-stdout path: no packer bounds the output, so keep the
    // per-message spill exactly as before (byte-identical).
    if (!budget) return assemble(conversations);

    // Budgeted shard path: original content, whole-message packing.
    let kept = conversations;
    let body = assemble(kept, { spill: false });

    // Reserve room for the [k/N] shard header the orchestrator prepends.
    const packBudget = {
      maxChars: Math.max(0, budget.maxChars - 200),
      maxTokens: Math.max(0, budget.maxTokens - 60),
    };
    while (kept.length > 1 && !withinBudget(body, packBudget)) {
      kept = kept.slice(1); // drop the oldest whole message
      body = assemble(kept, { spill: false });
    }
    if (!withinBudget(body, packBudget)) {
      // The single newest message alone overflows the shard budget: fall
      // back to its preview + pointer form rather than handing the
      // orchestrator an over-budget body to tail-trim blindly.
      body = assemble(kept, { spill: true });
    }
    return body;
  });
}

export async function initC4Session() {
  try {
    const recovery = recoveryContext();
    if (recovery?.blocked) return needsRecoveryCue(recovery) ? recoveryBlock(recovery) + '\n' : '';
    const sections = [await emitC4Checkpoint(), await emitC4Conversations()].filter(Boolean);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
