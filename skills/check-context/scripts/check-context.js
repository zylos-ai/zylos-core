#!/usr/bin/env node
/**
 * Check Context Usage Script (C4-integrated)
 * Enqueues /context command via control queue. With --with-restart-check,
 * also enqueues a follow-up decision to restart if usage exceeds 70%.
 *
 * Usage:
 *   node check-context.js                      # Just check context
 *   node check-context.js --with-restart-check  # Check + auto-restart decision
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const C4_CONTROL = path.join(os.homedir(), 'zylos/.claude/skills/comm-bridge/scripts/c4-control.js');

function enqueue(args) {
  try {
    const result = execFileSync('node', [C4_CONTROL, 'enqueue', ...args], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return result.trim();
  } catch (err) {
    console.error(`[check-context] Failed to enqueue: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const withRestart = process.argv.includes('--with-restart-check');

  // Step 1: Enqueue /context command (delivered to tmux as slash command)
  const step1 = enqueue([
    '--content', '/context',
    '--priority', '3',
    '--require-idle',
    '--ack-deadline', '600'
  ]);
  console.log(`[check-context] /context enqueued: ${step1}`);

  // Step 2: Enqueue restart decision (only for automated checks)
  if (withRestart) {
    const step2 = enqueue([
      '--content', 'If context usage exceeds 70%, use the restart-claude skill to restart. If context is under 70%, just acknowledge.',
      '--priority', '3',
      '--require-idle',
      '--available-in', '30',
      '--ack-deadline', '630'
    ]);
    console.log(`[check-context] Restart check enqueued: ${step2}`);
  }
}

main();
