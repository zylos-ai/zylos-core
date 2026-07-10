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

import { logHookTiming } from './c4-diagnostic.js';
import { formatSection } from './session-format.js';
import { withinBudget } from '../../activity-monitor/scripts/shard-registry.js';
import { fileURLToPath } from 'node:url';

async function withC4Db(label, action) {
  let close = () => {};
  try {
    const db = await import('./c4-db.js');
    close = db.close;
    return await action(db);
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
 * In shard mode the orchestrator passes the shard's budget, and over-budget
 * output is packed at MESSAGE granularity: whole oldest messages are dropped
 * until the newest ones fit inline. This shard must never rely on the generic
 * tail-trim + spill fallback — that would cut the NEWEST messages (the text
 * is chronological) and depend on the agent following a read-this-file
 * pointer. Dropped messages are not lost: Memory Sync reads c4.db directly,
 * so they are covered by the next checkpoint summary. Without a budget
 * (legacy single-stdout path) the output is byte-identical to before.
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

    const assemble = kept => {
      // Informational only — no file to read. Kept within the section so it
      // survives exactly as long as the section does.
      const note = kept.length < conversations.length
        ? `(showing the newest ${kept.length} of ${range.count} unsummarized messages inline; older ones are covered by the next Memory Sync checkpoint)\n\n`
        : '';
      const sections = [formatSection('RECENT CONVERSATIONS', note + formatConversationsForAgent(kept))];

      // If over threshold, append Memory Sync instruction
      if (needsSync) {
        sections.push(formatSection(
          'ACTION REQUIRED',
          `There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`,
        ));
      }

      return sections.join('\n\n');
    };

    let kept = conversations;
    let body = assemble(kept);
    if (!budget) return body;

    // Reserve room for the [k/N] shard header the orchestrator prepends.
    const packBudget = {
      maxChars: Math.max(0, budget.maxChars - 200),
      maxTokens: Math.max(0, budget.maxTokens - 60),
    };
    while (kept.length > 1 && !withinBudget(body, packBudget)) {
      kept = kept.slice(1); // drop the oldest whole message
      body = assemble(kept);
    }
    return body;
  });
}

export async function initC4Session() {
  try {
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
