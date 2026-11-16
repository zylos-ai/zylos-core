// Object API fixtures share the same observation fields as group detail responses.
export function conversationDetail(row, { readAt = 1000, statusKnown = true } = {}) {
  if (!row) return { readAt, state: { kind: 'unknown' } };
  const kind = !statusKnown ? 'unknown' : row.state?.kind
    ?? (row.presence === 'running' ? row.working?.on ? 'working' : 'idle'
      : row.presence === 'starting' ? 'starting' : row.presence === 'not_running' ? 'offline' : 'unknown');
  return { ...row, id: row.sessionGroup ?? 'origin', sessionGroup: Object.hasOwn(row, 'sessionGroup') ? row.sessionGroup : 'origin',
    readAt, ...(!statusKnown ? { presence: 'unknown', working: null, wait: null, target: null } : {}), state: { ...row.state, kind }, side: kind === 'offline' ? 'offline' : 'running', flags: row.flags ?? {},
    ...(kind === 'offline' ? {} : { mainAgent: row.working?.on ? 'busy' : 'idle' }) };
}
