/**
 * Attach to the Claude tmux session with a detach hint.
 */

import { execSync, execFileSync } from 'node:child_process';
import { bold } from '../lib/colors.js';

const SESSION = 'claude-main';

export function attachCommand() {
  // Check if tmux session exists
  try {
    execSync(`tmux has-session -t "${SESSION}" 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    // No tmux session — check why and give appropriate advice
    let pm2Running = false;
    try {
      const pm2Out = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
      const procs = JSON.parse(pm2Out);
      pm2Running = procs.some(p => p.name === 'activity-monitor' && p.pm2_env?.status === 'online');
    } catch {}

    if (pm2Running) {
      console.error(`No active Claude session yet. Activity monitor is running — Claude should start shortly.`);
      console.error(`  Check status: ${bold('zylos status')}`);
    } else {
      console.error(`No active Claude session found.`);
      console.error(`  First time? Run ${bold('zylos init')}`);
      console.error(`  Otherwise:  Run ${bold('zylos start')}`);
    }
    process.exit(1);
  }

  // Show detach hint inside tmux for 3 seconds on attach
  try {
    execSync(`tmux set-hook -t "${SESSION}" client-attached 'display-message -d 3000 " Tip: Ctrl+B d to detach "'`, { stdio: 'pipe' });
  } catch {}

  // Attach — hands over terminal to tmux
  try {
    execFileSync('tmux', ['attach', '-t', SESSION], { stdio: 'inherit' });
  } catch {
    // Normal exit when detaching
  }
}
