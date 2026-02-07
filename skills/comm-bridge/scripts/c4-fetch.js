#!/usr/bin/env node
/**
 * C4 Communication Bridge - Fetch Conversations
 * Returns checkpoint summary + conversations in a specified id range.
 * Used by Memory Sync skill and other consumers.
 *
 * Usage: node c4-fetch.js --begin <id> --end <id>
 */

import {
  getLastCheckpoint,
  getConversationsByRange,
  formatConversations,
  close
} from './c4-db.js';

function main() {
  const args = process.argv.slice(2);
  let beginId = null;
  let endId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--begin') {
      beginId = parseInt(args[++i]);
    } else if (args[i] === '--end') {
      endId = parseInt(args[++i]);
    }
  }

  if (beginId == null || endId == null || isNaN(beginId) || isNaN(endId)) {
    console.error('Usage: c4-fetch.js --begin <id> --end <id>');
    process.exit(1);
  }

  try {
    const checkpoint = getLastCheckpoint();
    const conversations = getConversationsByRange(beginId, endId);
    const lines = [];

    if (checkpoint?.summary) {
      lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
      lines.push('');
    }

    lines.push(`[Conversations] (id ${beginId} ~ ${endId})`);

    if (conversations.length === 0) {
      lines.push('No conversations in this range.');
    } else {
      lines.push(formatConversations(conversations));
    }

    console.log(lines.join('\n'));
  } catch (err) {
    console.error(`Error fetching conversations: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
  }
}

main();
