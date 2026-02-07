#!/usr/bin/env node
/**
 * C4 Communication Bridge - Checkpoint Interface
 * Creates a checkpoint to mark sync points
 *
 * Usage: node c4-checkpoint.js <end_conversation_id> [--summary "<summary>"]
 */

import { createCheckpoint, close } from './c4-db.js';

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args[0].startsWith('--')) {
    console.error('Usage: c4-checkpoint.js <end_conversation_id> [--summary "<summary>"]');
    process.exit(1);
  }

  const endConversationId = parseInt(args[0]);
  if (isNaN(endConversationId)) {
    console.error('end_conversation_id must be a number');
    process.exit(1);
  }

  let summary = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--summary') {
      summary = args[++i];
    }
  }

  try {
    const result = createCheckpoint(endConversationId, summary);
    console.log('Checkpoint created:', JSON.stringify(result));
  } catch (err) {
    console.error(`Error creating checkpoint: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
  }
}

main();
