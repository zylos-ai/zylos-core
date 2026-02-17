#!/usr/bin/env node
/**
 * Session start hook: enqueues a startup prompt via control queue
 * that tells Claude to resume work or reply to waiting partners.
 *
 * Delivered as a control message so Claude is actively triggered,
 * not just given passive context.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const C4_CONTROL = path.join(os.homedir(), 'zylos/.claude/skills/comm-bridge/scripts/c4-control.js');

const prompt = [
  'reply to your human partner if they are waiting your reply,',
  'and continue your work if you have ongoing task according to the previous conversations.'
].join(' ');

try {
  execFileSync('node', [
    C4_CONTROL, 'enqueue',
    '--content', prompt,
    '--priority', '2'
  ], { stdio: 'pipe' });
} catch {
  // Silently fail — session still starts even if enqueue fails
}
