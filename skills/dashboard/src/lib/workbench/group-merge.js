import { Sanitizer } from '../sanitizer.js';

export function c4Meta(item) {
  return item ? { componentName: item.componentName, sessionGroupName: item.sessionGroupName,
    lastActivityAt: item.lastActivityAt ?? null } : null;
}

export function safePreview(item, sanitizer = new Sanitizer('')) {
  return item?.preview ? { ...item.preview, text: sanitizer.safeSummary(item.preview.text) } : null;
}

export function mergeGroups({ status, c4, q, names = new Map(), statusError }, sanitizer = new Sanitizer('')) {
  if (status?.view === 'single') return { rows: [{ sessionGroup: null, title: '唯一会话',
    presence: status.origin.presence, live: status.origin, c4: null, preview: null, name: null, origin: true }], hasOlder: null };
  const live = new Map();
  if (status) {
    live.set('origin', status.origin);
    for (const row of status.groups) live.set(row.sessionGroup, row);
  }
  const listKnown = status != null && status.groupListError == null;
  const items = new Map((c4.ok ? c4.data.groups : []).map(row => [row.sessionGroup, row]));
  const keys = new Set(['origin', ...live.keys(), ...items.keys(), ...(q.ok ? q.data.groups.map(row => row.sessionGroup) : [])]);
  const rows = [...keys].map(key => {
    const current = live.get(key), item = items.get(key);
    return { sessionGroup: key, presence: current ? current.presence : listKnown ? 'not_running' : 'unknown',
      reason: current || listKnown ? null : statusError ?? 'group_list_failed', live: current ?? null,
      c4: c4Meta(item), preview: safePreview(item, sanitizer), name: names.get(key) ?? null, origin: key === 'origin' };
  });
  return { rows, hasOlder: c4.ok ? c4.data.hasOlder : null };
}
