import { requireGroupReadShape } from './groups-api.js';
import { parseSessionGroup } from '../../../../comm-bridge/scripts/c4-session-group.js';

const unreadable = () => ({ count: null, firstAt: null, reason: 'backlog_failed' });

/** The backlog page, group details and memory tree share a 30-second cache of per-group Dream coverage. */
export function createGroupBacklog({ c4Reader, readConfig, now = Date.now } = {}) {
  const cache = new Map();
  async function many(keys) {
    const at = now();
    for (const [scope, entry] of cache) {
      if (at - entry.at >= 30000) cache.delete(scope);
    }
    const unread = [...new Set(keys)].filter(scope => !cache.has(scope));
    const strict = unread.filter(scope => parseSessionGroup(scope));
    if (strict.length) {
      let ranges;
      try { ranges = c4Reader.getUnsummarizedRanges(strict, { readConfig }); }
      catch { ranges = []; }
      strict.forEach((scope, index) => {
        const range = ranges[index];
        const value = range && Number.isSafeInteger(range.count) && range.count >= 0
          ? { count: range.count, firstAt: range.firstAt ?? null }
          : unreadable();
        cache.set(scope, { at, value });
      });
    }
    // Historical group IDs cannot enter the strict Core range reader.
    for (const scope of unread.filter(scope => !parseSessionGroup(scope))) {
      let value;
      try { requireGroupReadShape(scope); value = c4Reader.getGroupBacklog(scope); }
      catch { value = unreadable(); }
      cache.set(scope, { at, value });
    }
    return keys.map(scope => cache.get(scope).value);
  }
  const groupBacklog = async key => (await many([key]))[0];
  groupBacklog.many = many;
  return groupBacklog;
}
