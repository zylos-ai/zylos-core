/**
 * kick-verify.js — post-launch confirmation that the Codex child carrying
 * this launch's kick sentinel argv is actually alive inside the target tmux
 * pane (#743). `tmux new-session` / paste returning 0 only proves the command
 * was issued, not that the spawn happened: with a missing or broken CODEX_BIN
 * tmux still exits 0 while the pane dies, and a first-start marker committed
 * on that evidence would mislabel the next real first boot as a resume.
 *
 * Detection is scoped to descendants of the target session's pane PID and
 * requires the full kick prompt as one exact argv item, so stale processes,
 * unrelated panes, or lookalike cmdline substrings cannot satisfy it. A
 * confirmation re-check after a short delay rejects children that spawn and
 * exit immediately. On timeout the caller must NOT commit the marker — the
 * conservative failure mode is that the next start reads as first boot again.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmuxGetPanePid } from './tmux-helpers.js';

const CMD_TIMEOUT = 3000;

function envInt(name) {
  const val = parseInt(process.env[name], 10);
  return Number.isInteger(val) && val > 0 ? val : undefined;
}

// ZYLOS_KICK_VERIFY_TIMEOUT_MS is a test hook (integration scenarios shorten
// the wait); production uses the default.
const DEFAULT_TIMEOUT_MS = envInt('ZYLOS_KICK_VERIFY_TIMEOUT_MS') ?? 10_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_CONFIRM_MS = 750;

function defaultListChildPids(pid) {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((line) => parseInt(line, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // pgrep exits non-zero when a PID has no children
  }
}

/**
 * Read a process's argv. On Linux /proc gives exact argv item boundaries;
 * elsewhere fall back to the joined `ps` command line, where the full kick
 * prompt is still specific enough for substring containment to discriminate.
 * @param {number} pid
 * @returns {string[]|{joined: string}|null}
 */
function defaultReadArgv(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const argv = raw.split('\0').filter(Boolean);
    if (argv.length > 0) return argv;
  } catch { /* /proc unavailable or process gone — try ps */ }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? { joined: out } : null;
  } catch {
    return null;
  }
}

function argvCarriesKick(argv, kickPrompt) {
  if (!argv) return false;
  if (Array.isArray(argv)) return argv.includes(kickPrompt);
  return argv.joined.includes(kickPrompt);
}

/**
 * Create a verifier function. Dependencies are injectable for unit tests;
 * production callers use the defaults.
 *
 * @returns {(opts: {session: string, kickPrompt: string, timeoutMs?: number,
 *   pollMs?: number, confirmMs?: number}) => Promise<boolean>}
 */
export function createKickVerifier({
  getPanePid = tmuxGetPanePid,
  listChildPids = defaultListChildPids,
  readArgv = defaultReadArgv,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  // BFS over the pane's process tree for a process whose argv carries the
  // exact kick prompt. Returns the PID or 0.
  function findKickPid(session, kickPrompt) {
    const panePid = getPanePid(session);
    if (!panePid) return 0;
    const queue = [panePid];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const pid = queue.shift();
      if (argvCarriesKick(readArgv(pid), kickPrompt)) return pid;
      for (const child of listChildPids(pid)) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return 0;
  }

  return async function waitForKickProcess({
    session,
    kickPrompt,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    confirmMs = DEFAULT_CONFIRM_MS,
  }) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const pid = findKickPid(session, kickPrompt);
      if (pid) {
        // The same PID must still carry the sentinel argv after a short
        // delay — a child that spawned and exited immediately (broken
        // CODEX_BIN) is not a successful start.
        await sleep(confirmMs);
        if (argvCarriesKick(readArgv(pid), kickPrompt)) return true;
        continue;
      }
      await sleep(pollMs);
    }
    return false;
  };
}
