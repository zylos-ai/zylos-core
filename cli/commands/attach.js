import { collectStatus } from '../lib/status-view.js';
import { describeOrigin, formatOriginDescription } from '../lib/origin-presence.js';
/**
 * Attach to the active runtime's tmux session with a detach hint.
 */

import { execSync, execFileSync } from 'node:child_process';
import { bold } from '../lib/colors.js';
import { resolveCliSession } from '../lib/cli-session.js';
import { tmuxSessionTarget } from '../lib/session-group-paths.js';
import { TMUX_COMMAND as C, TMUX_FORMAT as F } from '../lib/runtime/tmux-protocol.js';

export async function attachCommand({ resolve = resolveCliSession, exec = execFileSync, collect = collectStatus } = {}) {
  const { sessionGroup, live, runtime } = await resolve();
  const SESSION = tmuxSessionTarget(live.tmuxName);
  const RUNTIME_LABEL = runtime;
  // Check if tmux session exists
  try {
    exec('tmux', [C.hasSession, '-t', SESSION], { stdio: 'pipe' });
  } catch {
    if (sessionGroup !== null && sessionGroup !== undefined) {
      if (sessionGroup === 'origin') {
        const data = await collect();
        const description = describeOrigin({ ...data, targetRuntime: runtime, nowSec: Math.floor(data.readAt / 1000) });
        console.error(formatOriginDescription(description, runtime, data.originNeed) ?? `Origin session: ${description.state}.`);
      } else {
        console.error(`No active session for ${sessionGroup}. Group sessions start when a message for the group arrives.`);
      }
      process.exit(1);
      return;
    }
    // No tmux session — check why and give appropriate advice
    let pm2Running = false;
    try {
      const pm2Out = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
      const procs = JSON.parse(pm2Out);
      pm2Running = procs.some(p => p.name === 'activity-monitor' && p.pm2_env?.status === 'online');
    } catch {}

    if (pm2Running) {
      console.error(`No active ${RUNTIME_LABEL} session yet. Activity monitor is running — ${RUNTIME_LABEL} should start shortly.`);
      console.error(`  Check status: ${bold('zylos status')}`);
    } else {
      console.error(`No active ${RUNTIME_LABEL} session found.`);
      console.error(`  First time? Run ${bold('zylos init')}`);
      console.error(`  Otherwise:  Run ${bold('zylos start')}`);
    }
    process.exit(1);
  }

  // Show detach hint inside tmux for 3 seconds on attach
  try {
    exec('tmux', [C.setHook, '-t', `${SESSION}:`, 'client-attached', F.detachHint], { stdio: 'pipe' });
  } catch (error) { console.error(`Detach hint unavailable: ${error.message}`); }

  // Attach — hands over terminal to tmux
  try {
    exec('tmux', [C.attach, '-t', SESSION], { stdio: 'inherit' });
  } catch {
    // Normal exit when detaching
  }
}
