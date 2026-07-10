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
const FLAG_ROOT_NAME = 'zylos-shard-flags';

export function tLinkMs(env = process.env) {
  const raw = Number(env.ZYLOS_SHARD_T_LINK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_T_LINK_MS;
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
 * Resolves { ok, waitedMs }. `waitedMs` is kept for diagnostics: an abnormal
 * all-zeros pattern across shards is the fingerprint of broken session
 * isolation, and ok=false with the predecessor's content present is the
 * fingerprint of a flag-write bug.
 */
export async function waitForFlag(sessionId, shardName, {
  deadlineMs,
  pollMs = DEFAULT_POLL_INTERVAL_MS,
  tmpdir,
} = {}) {
  const target = flagPath(sessionId, shardName, tmpdir ? { tmpdir } : {});
  const startMs = Date.now();
  for (;;) {
    if (fs.existsSync(target)) {
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
