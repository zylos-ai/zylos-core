#!/usr/bin/env node
/**
 * C4 Communication Bridge - Checkpoint Interface
 * Creates a checkpoint to mark sync points
 *
 * Usage: node c4-checkpoint.js [--type <type>]
 * Types: memory_sync, session_start, manual (default: manual)
 */

const { createCheckpoint } = require('./c4-db');

const VALID_TYPES = ['memory_sync', 'session_start', 'manual'];

function printUsage() {
  console.log('Usage: node c4-checkpoint.js [--type <type>]');
  console.log('Types: memory_sync, session_start, manual (default: manual)');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let type = 'manual';

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type') {
      type = args[++i];
    } else if (!args[i].startsWith('--')) {
      // Allow type as positional argument
      type = args[i];
    }
  }

  // Validate type
  if (!VALID_TYPES.includes(type)) {
    console.error(`Error: Invalid type '${type}'. Must be: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  // Create checkpoint
  try {
    const result = createCheckpoint(type);
    console.log('Checkpoint created:', JSON.stringify(result));
  } catch (err) {
    console.error(`Error creating checkpoint: ${err.message}`);
    process.exit(1);
  }
}

main();
