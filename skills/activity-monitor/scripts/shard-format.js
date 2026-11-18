/** Shared startup header formatting, also used to reserve memory display space. */
import { MAX_SHARD_NAME_LENGTH } from './shard-registry.js';

/**
 * Numbered self-describing shard header. This is the fail-safe half of the
 * ordering design: a crashed shard leaves no trace in context at all (only a
 * transcript-level hook error), so a missing [k/N] number is the ONLY
 * in-context signal that a shard was lost. The header sits within the first
 * 2KB, so it survives the persisted-output preview if a budget is ever blown.
 */
export function shardHeader({ position, total, name, waitNote = '' }) {
  return `=== ZYLOS STARTUP CONTEXT [${position}/${total}] ${name}${waitNote ? ` (${waitNote})` : ''} ===`;
}

export function predecessorWaitNote(name, waitedMs) {
  return `predecessor "${name}" not ready after ${waitedMs}ms, continued`;
}

export function worstCaseShardHeader() {
  return shardHeader({
    position: Number.MAX_SAFE_INTEGER,
    total: Number.MAX_SAFE_INTEGER,
    name: 'x'.repeat(MAX_SHARD_NAME_LENGTH),
    waitNote: predecessorWaitNote('x'.repeat(MAX_SHARD_NAME_LENGTH), Number.MAX_SAFE_INTEGER),
  });
}
