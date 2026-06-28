#!/usr/bin/env node
/**
 * C4 Communication Bridge - Session Init
 * Called by session start hook. Outputs context prompt for Claude Code:
 * - Last checkpoint summary (always)
 * - Unsummarized conversations (all if ≤ threshold, last N if > threshold)
 * - Memory Sync instruction (only if > threshold)
 *
 * Usage: node c4-session-init.js
 */

import { logHookTiming } from './c4-diagnostic.js';
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
    const lines = [];

    // Always output last checkpoint summary
    if (checkpoint?.summary) {
      lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
      lines.push('');
    }

    if (range.count === 0) {
      lines.push('No new conversations since last checkpoint.');
      return `${lines.join('\n')}\n`;
    }

    const needsSync = range.count > CHECKPOINT_THRESHOLD;

    // Get conversations: all if under threshold, last N if over
    const conversations = needsSync
      ? getUnsummarizedConversations(SESSION_INIT_RECENT_COUNT)
      : getUnsummarizedConversations();

    lines.push('[Recent Conversations]');
    lines.push(formatConversations(conversations));

    // If over threshold, append Memory Sync instruction
    if (needsSync) {
      lines.push(`[Action Required] There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`);
    }

    return `${lines.join('\n')}\n`;
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
