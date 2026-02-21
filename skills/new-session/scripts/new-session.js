#!/usr/bin/env node
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');

function main() {
  try {
    execFileSync('node', [C4_CONTROL, 'enqueue',
      '--content', '/clear',
      '--priority', '1',
      '--require-idle',
      '--ack-deadline', '600'
    ], { encoding: 'utf8', stdio: 'pipe' });
    console.log('[new-session] /clear enqueued');
  } catch (err) {
    console.error('[new-session] Failed to enqueue /clear: ' + err.message);
    process.exit(1);
  }
}

main();
