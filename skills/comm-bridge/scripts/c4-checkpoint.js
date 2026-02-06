#!/usr/bin/env node
/**
 * C4 Communication Bridge - Checkpoint Interface
 * Creates a checkpoint to mark sync points
 *
 * Usage: node c4-checkpoint.js [--type <type>] [--summary "<summary>"]
 * Types: memory_sync, session_start, manual (default: manual)
 */

import { createCheckpoint } from './c4-db.js';

const VALID_TYPES = ['memory_sync', 'session_start', 'manual'];

function printUsage() {
  console.log('Usage: node c4-checkpoint.js [--type <type>] [--summary "<summary>"]');
  console.log('Types: memory_sync, session_start, manual (default: manual)');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let type = 'manual';
  let summary = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type') {
      type = args[++i];
    } else if (args[i] === '--summary') {
      summary = args[++i];
    } else if (!args[i].startsWith('--')) {
      type = args[i];
    }
  }

  if (!VALID_TYPES.includes(type)) {
    console.error(`Error: Invalid type '${type}'. Must be: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  try {
    const result = createCheckpoint(type, summary);
    console.log('Checkpoint created:', JSON.stringify(result));
  } catch (err) {
    console.error(`Error creating checkpoint: ${err.stack}`);
    process.exit(1);
  }
}

main();
