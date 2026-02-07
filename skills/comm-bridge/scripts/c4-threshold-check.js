#!/usr/bin/env node
/**
 * C4 Communication Bridge - Threshold Check
 * Lightweight check called by user message hook.
 * Only outputs when unsummarized conversation count exceeds threshold.
 * Silent (no output) when under threshold.
 *
 * Usage: node c4-threshold-check.js
 */

import { getUnsummarizedRange, close } from './c4-db.js';
import { CHECKPOINT_THRESHOLD } from './c4-config.js';

function main() {
  try {
    const range = getUnsummarizedRange();

    if (range.count > CHECKPOINT_THRESHOLD) {
      console.log(`[Action Required] There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please invoke Memory Sync skill to process them: /memory-sync --begin ${range.begin_id} --end ${range.end_id}`);
    }
  } catch (err) {
    console.error(`Error in threshold check: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
  }
}

main();
