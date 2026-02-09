#!/usr/bin/env node
/**
 * C4 Communication Bridge - Checkpoint Interface
 *
 * Commands:
 *   create <end_conversation_id> [--summary "<summary>"]
 *   list [--limit <n>]
 *   latest
 *
 */

import { createCheckpoint, getCheckpoints, getLastCheckpoint, close } from './c4-db.js';

function usage() {
  console.error('Usage: c4-checkpoint.js <command> [options]');
  console.error('  create <end_conversation_id> [--summary "<summary>"]');
  console.error('  list [--limit <n>]');
  console.error('  latest');
}

function errorExit(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseStringArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value) errorExit(`missing value for ${flag}`);
  return value;
}

function parseNumberArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const raw = args[idx + 1];
  if (!raw) errorExit(`missing value for ${flag}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    errorExit(`${flag} must be a number`);
  }
  return value;
}

function handleCreate(args) {
  if (args.length < 1 || args[0].startsWith('--')) {
    errorExit('create requires <end_conversation_id>');
  }

  const endConversationId = parseInt(args[0]);
  if (isNaN(endConversationId)) {
    errorExit('end_conversation_id must be a number');
  }

  const summary = parseStringArg(args, '--summary');

  const result = createCheckpoint(endConversationId, summary);
  console.log('Checkpoint created:', JSON.stringify(result));
}

function handleList(args) {
  const limit = parseNumberArg(args, '--limit');
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    errorExit('--limit must be a positive integer');
  }

  let rows = getCheckpoints();
  if (limit !== null) {
    rows = rows.slice(0, limit);
  }
  console.log(JSON.stringify(rows, null, 2));
}

function handleLatest() {
  const row = getLastCheckpoint();
  if (!row) {
    errorExit('no checkpoints found');
  }
  console.log(JSON.stringify(row, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  try {
    switch (command) {
      case 'create':
        handleCreate(args.slice(1));
        break;
      case 'list':
        handleList(args.slice(1));
        break;
      case 'latest':
        handleLatest();
        break;
      default:
        usage();
        errorExit(`unknown command: ${command}`);
    }
  } finally {
    close();
  }
}

main();
