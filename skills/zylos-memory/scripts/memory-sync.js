#!/usr/bin/env node
/**
 * Memory Sync helper.
 *
 * Subcommands:
 *   fetch                 Determine unsummarized range and print conversations
 *   checkpoint [--summary "..."]
 *                         Create checkpoint using saved fetch range
 *   status                Show current unsummarized range + saved fetch range
 */

import fs from 'fs';
import path from 'path';
import {
  getUnsummarizedRange,
  getConversationsByRange,
  createCheckpoint,
  formatConversations,
  close
} from '../../comm-bridge/scripts/c4-db.js';
import { ZYLOS_DIR } from './shared.js';

const STATE_FILE = path.join(ZYLOS_DIR, 'zylos-memory', 'last-fetch-range.json');

function usage() {
  return `Memory Sync Helper

Usage:
  memory-sync.js fetch
  memory-sync.js checkpoint [--summary "text"]
  memory-sync.js status
`;
}

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function writeRange(range) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(range, null, 2)}\n`, 'utf8');
}

function readSavedRange() {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed.end_id !== 'number') {
    throw new Error(`Invalid saved range in ${STATE_FILE}`);
  }

  return parsed;
}

function getArgValue(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return null;
  }
  return args[idx + 1] ?? null;
}

function handleFetch() {
  const range = getUnsummarizedRange();

  if (!range || range.count === 0) {
    console.log('No unsummarized conversations.');
    return;
  }

  writeRange(range);

  const conversations = getConversationsByRange(range.begin_id, range.end_id);
  const lines = [];
  lines.push(`[Conversations] (id ${range.begin_id} ~ ${range.end_id})`);

  if (!conversations || conversations.length === 0) {
    lines.push('No conversations in this range.');
  } else {
    lines.push(formatConversations(conversations));
  }

  console.log(lines.join('\n'));
}

function handleCheckpoint(args) {
  const savedRange = readSavedRange();
  if (!savedRange) {
    throw new Error('No saved fetch range. Run "memory-sync.js fetch" first.');
  }

  const summary = getArgValue(args, '--summary') || 'Memory sync checkpoint';
  const checkpoint = createCheckpoint(savedRange.end_id, summary);

  try {
    fs.unlinkSync(STATE_FILE);
  } catch (err) {
    console.warn(`Warning: checkpoint created but failed to remove state file: ${err.message}`);
  }

  console.log(`Checkpoint created: ${JSON.stringify(checkpoint)}`);
}

function handleStatus() {
  const unsummarized = getUnsummarizedRange();
  let savedRange = null;

  try {
    savedRange = readSavedRange();
  } catch (err) {
    savedRange = { error: err.message };
  }

  console.log(JSON.stringify({ unsummarized, savedRange }, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(usage());
    return;
  }

  try {
    switch (command) {
      case 'fetch':
        handleFetch();
        break;
      case 'checkpoint':
        handleCheckpoint(args.slice(1));
        break;
      case 'status':
        handleStatus();
        break;
      default:
        console.log(usage());
    }
  } catch (err) {
    console.error(`memory-sync error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    close();
  }
}

main();
