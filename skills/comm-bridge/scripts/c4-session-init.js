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
import { fileURLToPath } from 'node:url';

export async function initC4Session() {
  let close = () => {};
  try {
    const {
      getLastCheckpoint,
      getUnsummarizedRange,
      getUnsummarizedConversations,
      formatConversations,
      close: closeDb,
    } = await import('./c4-db.js');
    close = closeDb;
    const { CHECKPOINT_THRESHOLD, SESSION_INIT_RECENT_COUNT } = await import('./c4-config.js');

    const checkpoint = getLastCheckpoint();
    const range = getUnsummarizedRange();
    const sections = [];

    // Always surface the last checkpoint. Summary present → show it; summary
    // null → emit a fallback so the block never silently disappears.
    if (checkpoint) {
      if (checkpoint.summary) {
        sections.push(formatSection('LAST CHECKPOINT SUMMARY', checkpoint.summary));
      } else {
        sections.push(formatSection(
          'LAST CHECKPOINT',
          `(no summary — checkpoint #${checkpoint.id}, ${checkpoint.timestamp})`,
        ));
      }
    }

    if (range.count === 0) {
      sections.push(formatSection('RECENT CONVERSATIONS', 'No new conversations since last checkpoint.'));
      return `${sections.join('\n\n')}\n`;
    }

    const needsSync = range.count > CHECKPOINT_THRESHOLD;

    // Get conversations: all if under threshold, last N if over
    const conversations = needsSync
      ? getUnsummarizedConversations(SESSION_INIT_RECENT_COUNT)
      : getUnsummarizedConversations();

    sections.push(formatSection('RECENT CONVERSATIONS', formatConversations(conversations)));

    // If over threshold, append Memory Sync instruction
    if (needsSync) {
      sections.push(formatSection(
        'ACTION REQUIRED',
        `There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`,
      ));
    }

    return `${sections.join('\n\n')}\n`;
  } catch (err) {
    const wrapped = new Error(`Error in session init: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  } finally {
    close();
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
