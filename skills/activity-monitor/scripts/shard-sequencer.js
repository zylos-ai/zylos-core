/**
 * Session-start shard sequencer.
 *
 * Multiple SessionStart hooks run in parallel and their stdout is injected in
 * completion order, not config order (undocumented runtime behavior, verified
 * experimentally for both Claude Code and Codex). This module pins completion
 * order to chain order with flag files:
 *
 * - Each shard waits for its predecessor's flag before writing stdout, then
 *   writes its own flag.
 * - Flag directories are isolated per session_id. Isolation is a correctness
 *   requirement, not hygiene: a shared flag directory poisoned by stale flags
 *   reverses the whole chain (all waits return instantly, output degrades to
 *   raw completion order).
 * - Session isolation alone does not cover re-triggers WITHIN a session:
 *   compact fires SessionStart with the SAME session_id as startup (verified
 *   experimentally on Claude Code, 2026-07-10), so the startup round's flags
 *   would satisfy every compact-round wait instantly. Waits therefore also
 *   require the flag to be FRESH — written no earlier than this process's
 *   start minus a skew tolerance. Old-round flags count as absent; the
 *   predecessor's rewrite this round bumps the mtime and unblocks normally.
 * - Waits use a ladder deadline — shard k (1-based chain position) waits at
 *   most (k-1) x T_LINK. A flat deadline makes every shard downstream of a
 *   mid-chain failure expire simultaneously and race; the ladder keeps
 *   survivors strictly ordered.
 * - All waits fail open: a missing predecessor delays a shard, never drops it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_T_LINK_MS = 1_000;
export const DEFAULT_POLL_INTERVAL_MS = 25;
export const DEFAULT_FLAG_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_FLAG_FRESH_TOLERANCE_MS = 10_000;

// True process start, not module-load time: shard processes call waitForFlag
// almost immediately, but a slow require chain must not shift the cutoff.
const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

/**
 * Per-user suffix for working-dir roots under the shared temp dir. A fixed
 * root name breaks multi-user hosts: the first zylos user creates it 0755,
 * every other user then gets EACCES on writes inside it — and because flag
 * writes are best-effort, sequencing silently degrades to completion order
 * (each shard burning its full ladder deadline) and spills become
 * unwritable. uid keeps the name stable per user; username is the Windows
 * fallback where getuid is unavailable.
 */
export function perUserSuffix() {
  if (typeof process.getuid === 'function') return String(process.getuid());
  try {
    return String(os.userInfo().username).replace(/[^A-Za-z0-9._-]/g, '_') || 'nouser';
  } catch {
    return 'nouser';
  }
}

const FLAG_ROOT_NAME = `zylos-shard-flags-${perUserSuffix()}`;

export function tLinkMs(env = process.env) {
  const raw = Number(env.ZYLOS_SHARD_T_LINK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_T_LINK_MS;
}

export function flagFreshToleranceMs(env = process.env) {
  const raw = Number(env.ZYLOS_SHARD_FLAG_FRESH_TOLERANCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_FLAG_FRESH_TOLERANCE_MS;
}

/**
 * Freshness cutoff for flag acceptance: flags written before this instant are
 * treated as leftovers from an earlier trigger of the same session (compact
 * reuses the session_id) and ignored. The tolerance absorbs sibling spawn
 * skew and coarse filesystem mtime granularity; its failure directions are
 * asymmetric — too tight only costs a ladder wait (fail-open), too loose only
 * risks old-round flags being honored when a re-trigger lands within the
 * tolerance of the previous round, which a context-full compact cannot do.
 */
export function defaultFreshAfterMs() {
  return PROCESS_START_MS - flagFreshToleranceMs();
}

/**
 * Ladder deadline for a shard's predecessor wait. `chainIndex` is 0-based, so
 * the first shard waits 0ms and shard k (1-based) waits (k-1) x T_LINK.
 */
export function ladderDeadlineMs(chainIndex, linkMs = tLinkMs()) {
  return Math.max(0, chainIndex) * linkMs;
}

function sanitizeSessionId(sessionId) {
  const cleaned = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(0, 128);
}

export function flagRoot({ tmpdir = os.tmpdir() } = {}) {
  return path.join(tmpdir, FLAG_ROOT_NAME);
}

export function sessionFlagDir(sessionId, options = {}) {
  return path.join(flagRoot(options), sanitizeSessionId(sessionId));
}

export function flagPath(sessionId, shardName, options = {}) {
  return path.join(sessionFlagDir(sessionId, options), `${shardName}.flag`);
}

/**
 * Write this shard's completion flag. Must be called AFTER the shard's stdout
 * write — the flag is the "my bytes are out" signal successors wait on.
 * Best effort: a failed flag write only costs successors their ladder wait.
 */
export function writeFlag(sessionId, shardName, options = {}) {
  try {
    fs.mkdirSync(sessionFlagDir(sessionId, options), { recursive: true });
    fs.writeFileSync(flagPath(sessionId, shardName, options), '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll for a predecessor's flag until it appears or `deadlineMs` elapses.
 * A flag only counts if its mtime is at or after `freshAfterMs` — flags left
 * by an earlier trigger of the same session (compact keeps the session_id)
 * are treated as absent. Resolves { ok, waitedMs }. `waitedMs` is kept for
 * diagnostics: an abnormal all-zeros pattern across shards is the fingerprint
 * of broken session isolation, and ok=false with the predecessor's content
 * present is the fingerprint of a flag-write bug.
 */
export async function waitForFlag(sessionId, shardName, {
  deadlineMs,
  pollMs = DEFAULT_POLL_INTERVAL_MS,
  tmpdir,
  freshAfterMs = defaultFreshAfterMs(),
} = {}) {
  const target = flagPath(sessionId, shardName, tmpdir ? { tmpdir } : {});
  const startMs = Date.now();
  for (;;) {
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(target).mtimeMs;
    } catch {
      // Absent (or swept mid-poll) — keep waiting.
    }
    if (mtimeMs != null && mtimeMs >= freshAfterMs) {
      return { ok: true, waitedMs: Date.now() - startMs };
    }
    const elapsed = Date.now() - startMs;
    if (elapsed >= deadlineMs) {
      return { ok: false, waitedMs: elapsed };
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadlineMs - elapsed)));
  }
}

/**
 * Best-effort removal of flag directories left behind by crashed or aborted
 * sessions. Stale directories are harmless while isolation holds (each run
 * uses its own session_id), so this is a bounded janitor, not a correctness
 * mechanism.
 */
export function sweepStaleFlags({ ttlMs = DEFAULT_FLAG_TTL_MS, tmpdir } = {}) {
  const root = flagRoot(tmpdir ? { tmpdir } : {});
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return removed;
  }
  const cutoff = Date.now() - ttlMs;
  for (const entry of entries) {
    const dir = path.join(root, entry);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Another process may have swept it first.
    }
  }
  return removed;
}
