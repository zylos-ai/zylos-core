import { readGroupPages } from './group-data.js';

// A blocked runtime puts the conversation header in its restricted (amber) state.
const RESTRICTED_HEALTH = ['auth_failed', 'unavailable', 'down', 'rate_limited', 'recovering'];

/**
 * One group-list row as the conversation header would show its group:
 * 'working', 'idle', 'waiting' (queued, gray), 'stuck' (restricted, amber),
 * 'offline', or null when the state cannot be read.
 */
export function listPresence(row, health = {}, { offline = false } = {}) {
  const kind = offline ? 'offline' : row?.state?.kind;
  if (!kind || kind === 'unknown') return null;
  const flags = row.flags ?? {};
  const status = row.runtime == null ? null : health?.[row.runtime]?.health;
  if (RESTRICTED_HEALTH.includes(status) || flags.blocked || kind === 'stopping' || (offline && flags.startFailed)) return 'stuck';
  if (offline || (kind === 'idle' && flags.queued)) return 'waiting';
  if (kind === 'working' || kind === 'starting') return 'working';
  return kind === 'idle' ? 'idle' : null;
}

/**
 * Every group's presence for the conversation list: the running groups, the
 * offline groups with queued messages (the only offline groups the header shows
 * as waiting or restricted) and the instance's runtime health. A group missing
 * from complete lists is offline; a listed group maps to null when its state cannot
 * be read. In single-session mode only Origin is a group.
 */
export async function readListPresence(read) {
  const instance = await read('/api/instance');
  const health = instance?.runtimeHealth ?? {};
  const groups = new Map();
  let known = true;
  for (const [side, flag] of [['running', undefined], ['offline', 'queued']]) {
    const page = await readGroupPages(read, { side, flag, pages: Infinity });
    if (page.listKnown !== true) known = false;
    for (const row of page.rows) {
      if (typeof row.sessionGroup !== 'string') continue;
      // A listed group whose state cannot be read shows none, not offline.
      groups.set(row.sessionGroup, listPresence(row, health, { offline: side === 'offline' }));
    }
  }
  const multi = instance?.session_mode?.sessionMode === 'multi';
  if (!multi) for (const id of [...groups.keys()]) if (id !== 'origin') groups.delete(id);
  return { groups, complete: known && multi };
}

/**
 * Keeps the list's presence current. States change often (every tool step), so
 * reads never overlap and a change during a read is read once more a second later.
 * A failed read shows no state at all, as the header shows none.
 */
export function createListPresence({ read, onChange, setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  let current = { groups: new Map(), complete: false };
  let running = false, queued = false, timer = null, stopped = false;
  async function load() {
    running = true;
    try {
      current = await readListPresence(read);
    } catch {
      current = { groups: new Map(), complete: false };
    } finally {
      running = false;
      if (!stopped) {
        onChange();
        if (queued) {
          queued = false;
          // The read about to start covers every change so far.
          timer = later(() => { timer = null; queued = false; refresh(); }, 1000);
        }
      }
    }
  }
  function refresh() {
    if (stopped) return;
    if (running || timer !== null) { queued = true; return; }
    void load();
  }
  return {
    refresh,
    of(group) {
      if (typeof group !== 'string') return null;
      if (current.groups.has(group)) return current.groups.get(group);
      return current.complete ? 'offline' : null;
    },
    destroy() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}
