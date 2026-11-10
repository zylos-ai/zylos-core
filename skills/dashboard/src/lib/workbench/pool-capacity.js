import { loadCoreModule as defaultLoadCoreModule } from '../core-modules.js';

/** Read Core's effective limit and the same unexpired occupancy used by Router. */
export async function readPool({ mode, now = Date.now(), sample, c4Reader, loadCoreModule = defaultLoadCoreModule } = {}) {
  const pool = Object.fromEntries(['ready', 'starting', 'reclaiming', 'waiting'].map(key => [key, sample?.[key] ?? null]));
  if (mode !== 'multi') return { ...pool, capacity: null,
    used: pool.ready === null ? null : pool.ready + pool.starting, occupancy: null };
  let cap = { k: null, record: null, valid: false, fresh: false };
  try { cap = (await loadCoreModule('session-pool-config.js')).readPoolCapacity({ now }); }
  catch { /* Core unavailable: leave the limit unknown rather than invent one. */ }
  const record = cap.record;
  const capacityRecord = { valid: cap.valid, fresh: cap.fresh,
    ...Object.fromEntries(['source', 'reason', 'memory', 'model', 'kMemory']
      .filter(key => record != null && Object.hasOwn(record, key)).map(key => [key, record[key]])) };
  let occupancy = null;
  try { occupancy = c4Reader.listSlotOccupancy(now); }
  catch { /* A missing table or unreadable connection is not an empty pool. */ }
  return { ...pool,
    capacity: cap.k, used: occupancy?.length ?? null, capacityRecord, occupancy,
    ...(occupancy === null ? { reason: 'pool_occupancy_unreadable' } : {}) };
}

/** Inbound order at snapshot time; Router's per-round opportunities are private. */
export function poolPositions(rows, occupancy) {
  const owners = new Set((occupancy ?? []).map(slot => slot.sessionGroup));
  const candidates = rows.filter(row => row.sessionGroup !== 'origin' && row.sessionGroup !== null &&
    row.queue.known !== false && row.queue.pending.count > 0 && row.queue.pending.head != null &&
    row.presence === 'not_running' && row.fence == null && !owners.has(row.sessionGroup));
  candidates.sort((a, b) => a.queue.pending.head.priority - b.queue.pending.head.priority ||
    a.queue.pending.head.id - b.queue.pending.head.id);
  return new Map(candidates.map((row, index) => [row.sessionGroup, index + 1]));
}
