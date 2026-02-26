/**
 * Attach to the Claude tmux session with a detach hint.
 */

import { execSync, execFileSync } from 'node:child_process';
import { bold, yellow } from '../lib/colors.js';

const SESSION = 'claude-main';

export function attachCommand() {
  // Check if tmux session exists
  try {
    execSync(`tmux has-session -t "${SESSION}" 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    console.error(`No active Claude session found. Run ${bold('zylos start')} first.`);
    process.exit(1);
  }

  console.log(`${yellow('Tip:')} Press ${bold('Ctrl+B')} then ${bold('d')} to detach from this session.\n`);

  // Attach using execFileSync to hand over the terminal
  try {
    execFileSync('tmux', ['attach', '-t', SESSION], { stdio: 'inherit' });
  } catch {
    // Normal exit when detaching
  }
}
