import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TMUX_SESSION } from './c4-config.js';
import { readProcessStart, runtimeRoot, isManagedClaudeProcess } from '../../activity-monitor/scripts/runtime-generation.js';

export function readDeliveryIdentity({ zylosDir = runtimeRoot(), session = TMUX_SESSION,
  read = fs.readFileSync, run = execFileSync, processStart = readProcessStart } = {}) {
  try {
    const foreground = JSON.parse(read(path.join(zylosDir, 'activity-monitor/foreground-session.json'), 'utf8'));
    if (!foreground.session_id || !foreground.process_start || !isManagedClaudeProcess(foreground.claude_pid, {
      session, expectedStart: foreground.process_start, processStart, read, run,
    })) return null;
    return { runtime:'claude', session_id:foreground.session_id,
      process_start:foreground.process_start, claude_pid:foreground.claude_pid };
  } catch { return null; }
}
