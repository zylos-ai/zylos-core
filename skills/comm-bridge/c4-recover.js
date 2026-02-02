#!/usr/bin/env node
/**
 * C4 Communication Bridge - Recovery Interface
 * Retrieves conversations since last checkpoint for session recovery
 *
 * Usage: node c4-recover.js
 * Output: Formatted text for Claude context injection
 */

const { getConversationsSinceLastCheckpoint, formatForRecovery } = require('./c4-db');

function main() {
  try {
    const conversations = getConversationsSinceLastCheckpoint();

    if (!conversations || conversations.length === 0) {
      console.log('No conversations since last checkpoint.');
      return;
    }

    const formatted = formatForRecovery(conversations);
    console.log(formatted);
  } catch (err) {
    console.error(`Error recovering conversations: ${err.message}`);
    process.exit(1);
  }
}

main();
