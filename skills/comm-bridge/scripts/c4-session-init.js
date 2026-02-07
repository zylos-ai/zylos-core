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

import {
  getLastCheckpoint,
  getUnsummarizedRange,
  getUnsummarizedConversations,
  formatConversations,
  close
} from './c4-db.js';
import { CHECKPOINT_THRESHOLD, SESSION_INIT_RECENT_COUNT } from './c4-config.js';

function main() {
  try {
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
      console.log(lines.join('\n'));
      return;
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
      lines.push(`[Action Required] There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please invoke Memory Sync skill to process them: /memory-sync --begin ${range.begin_id} --end ${range.end_id}`);
    }

    console.log(lines.join('\n'));
  } catch (err) {
    console.error(`Error in session init: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
  }
}

main();
