#!/usr/bin/env node
/**
 * Web Console Send Script
 *
 * This is a no-op script for the web channel.
 * Messages are already recorded in c4.db by c4-send.js before this is called.
 * The web console frontend polls /api/poll to retrieve new messages.
 *
 * Usage: node send.js <endpoint> <message>
 *
 * Exit code 0 = success (message will be picked up by web console polling)
 */

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: node send.js <endpoint> <message>');
  process.exit(1);
}

// Message is already in database, web console will poll for it
console.log(`Message queued for web console`);
process.exit(0);
