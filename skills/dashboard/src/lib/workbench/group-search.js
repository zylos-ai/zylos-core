import { olderRow } from '../../../public/js/wb/older-row.js';
import { c4Meta, safePreview } from './group-merge.js';

export function searchTerm(q) {
  const term = String(q ?? '').trim();
  if (term.length < 1 || term.length > 64) return { none: true };
  return { term, keyable: /^[A-Za-z0-9_.:-]+$/.test(term) && !term.startsWith('--') };
}

export async function searchGroups(q, { now = Date.now(), runC4Db, getSnapshot,
  displayNames = { search: () => [], listAll: () => new Map() }, sanitizer } = {}) {
  const term = searchTerm(q);
  if (term.none) return { rows: [], truncated: false };
  const result = term.keyable ? await runC4Db(['groups', '--key-match', term.term, '--limit', '50', '--json']) : { ok: true, data: [] };
  if (!result.ok) throw Object.assign(new Error('Group search failed'), { statusCode: 502, code: 'group_search_failed', reason: 'c4_groups_failed' });
  const matches = await displayNames.search(term.term, 50), names = await displayNames.listAll();
  const snapshot = await getSnapshot(now), byKey = new Map(result.data.map(item => [item.sessionGroup, item]));
  const keys = [...new Set([...byKey.keys(), ...matches.map(item => item.sessionGroup)])];
  const live = new Map(snapshot.rows.map(row => [row.sessionGroup, row]));
  const rows = keys.map(key => live.get(key) ?? olderRow(key, {
    meta: c4Meta(byKey.get(key)), preview: safePreview(byKey.get(key), sanitizer),
    name: names.get(key) ?? null, listKnown: snapshot.listKnown,
  }));
  return { rows, truncated: result.data.length === 50 || matches.length === 50 };
}
