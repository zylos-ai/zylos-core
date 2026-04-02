/**
 * session-handoff.js — shared logic for triggering a context-based session switch.
 *
 * Used as the onExceed callback from ContextMonitorBase.startPolling() for both
 * Claude Code and Codex runtimes.
 *
 * Claude Code flow:
 *   enqueueNewSession() → C4 delivers control message → Claude runs new-session skill
 *   (Claude handles /clear and pre-flush summary internally)
 *
 * Codex flow:
 *   enqueueNewSession() → C4 delivers control message → Codex runs new-session skill
 *   (handoff summary + /exit)
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');

/**
 * Enqueue a new-session control message via C4 communication bridge.
 *
 * This triggers the currently running agent to perform a session handoff.
 * bypass-state is set so the message is delivered even when health !== 'ok'.
 *
 * @param {object} opts
 * @param {number}  opts.ratio       Context usage ratio (0.0–1.0)
 * @param {number}  opts.used        Tokens used
 * @param {number}  opts.ceiling     Token ceiling
 * @param {string}  [opts.runtime='claude']  Runtime id ('claude' | 'codex')
 * @param {number}  [opts.maxRetries=3]  Maximum enqueue attempts
 * @returns {boolean} true if enqueued successfully
 */
export function enqueueNewSession({ ratio = 0, used = 0, ceiling = 0, runtime = 'claude', maxRetries = 3 } = {}) {
  const pct = Math.round(ratio * 100);
  const base =
    `Context usage at ${pct}% ` +
    `(${used.toLocaleString()} / ${ceiling.toLocaleString()} tokens), ` +
    'exceeding threshold.';
  const content = runtime === 'codex'
    ? `${base} Run $new-session now and follow SKILL.md in order. Write/send the session handoff summary before the final session-switch command; do not skip checklist steps.`
    : `${base} Use the new-session skill to start a fresh session.`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execFileSync('node', [C4_CONTROL, 'enqueue',
        '--content', content,
        '--priority', '1',
        '--bypass-state',
        '--no-ack-suffix',
      ], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
      return true;
    } catch {
      if (attempt === maxRetries) return false;
    }
  }
  return false;
}
