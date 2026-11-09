const NOTICE_AFTER_MS = 10000;
const privateChannels = new Set(['internal', 'system', 'void']);

/** One capacity episode per conversation, driven by the Router's existing poll.
 * Notice I/O is tracked separately so it cannot hold a scheduling lane. */
export function createCapacityWaits({ deps, state, options, diagnostic, now, track }) {
  const waits = new Map();
  let stopped = false;
  function clear(group) { waits.delete(group); }
  function wait(group, record = null, launchConfig) {
    if (stopped || group === null || group === 'origin') return;
    const config = launchConfig ?? deps.db.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: state.mode });
    const health = deps.readRuntimeHealth(config.runtime);
    // Health holds have their own notices; only healthy/fail-open admission is
    // waiting for capacity. Do not carry health time into a later capacity wait.
    if (!health.missing && (health.unreadable || health.health !== 'ok')) { clear(group); return; }
    if (!state.sceneObservable || state.slots.size < options.poolSize()) return;
    let episode = waits.get(group);
    // A rowless continuation may already be waiting. An arriving user message
    // starts its own receipt clock rather than inheriting that earlier wait.
    if (record && episode && !episode.hasMessage) { clear(group); episode = null; }
    if (!episode) {
      episode = { startedAt: now(), notified: false, hasMessage: Boolean(record) };
      waits.set(group, episode);
      diagnostic('wait_capacity', { session_group: group, conversation_id: record?.id ?? null,
        wait_started_at_ms: episode.startedAt, occupied_slots: state.slots.size, pool_limit: options.poolSize() });
    }
    if (episode.notified || now() - episode.startedAt <= NOTICE_AFTER_MS || !record ||
        record.direction !== 'in' || !record.endpoint_id || privateChannels.has(record.channel) ||
        typeof deps.sendStatusNotice !== 'function') return;
    // Set before yielding: another row/tick in this episode cannot send again,
    // including when the existing cooldown or an uncertain send suppresses it.
    episode.notified = true;
    const sending = Promise.resolve().then(() => {
      if (stopped || waits.get(group) !== episode) return { outcome: 'skipped' };
      const latest = deps.readRuntimeHealth(config.runtime);
      if (!latest.missing && (latest.unreadable || latest.health !== 'ok')) {
        clear(group); return { outcome: 'skipped' };
      }
      return deps.sendStatusNotice(record, {
        decision: 'capacity_wait', context: 'capacity', noticeCode: 'capacity_wait',
        noticeKind: 'capacity_wait', health: 'capacity_wait', reason: 'capacity_wait', runtime: config.runtime,
      });
    }).then(result => diagnostic('capacity_wait_notice', { session_group: group, conversation_id: record.id,
      wait_started_at_ms: episode.startedAt, wait_ms: Math.max(0, now() - episode.startedAt), outcome: result?.outcome ?? 'unknown' }),
    error => diagnostic('capacity_wait_notice', { session_group: group, conversation_id: record.id,
      wait_started_at_ms: episode.startedAt, outcome: 'failed', reason: error.code ?? 'notice_failed' }));
    track(sending);
  }
  function acquired(group) {
    const episode = waits.get(group);
    if (!episode) return;
    clear(group);
    diagnostic('capacity_wait_acquired', { session_group: group, wait_started_at_ms: episode.startedAt,
      wait_ms: Math.max(0, now() - episode.startedAt), occupied_slots: state.slots.size, pool_limit: options.poolSize() });
  }
  function sweep(groups) { for (const group of waits.keys()) if (!groups.has(group)) clear(group); }
  return { wait, acquired, clear, sweep, stop: () => { stopped = true; waits.clear(); } };
}
