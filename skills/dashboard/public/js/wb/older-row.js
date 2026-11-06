/** A searched historical group has no sampled live or queue observations. */
export function olderRow(sessionGroup, { meta = null, preview = null, name = null, listKnown } = {}) {
  const reason = listKnown ? null : 'group_list_failed';
  return { sessionGroup, presence: listKnown ? 'not_running' : 'unknown', reason, c4: meta, preview, name,
    origin: sessionGroup === 'origin', live: null,
    state: { kind: listKnown ? 'not_running' : 'unknown', ...(reason ? { reason } : {}) }, duration: null,
    tools: [], wait: null, queue: null, fence: null, target: null, desired: null, contextPct: null,
    launchConfig: null, createdAt: null };
}
