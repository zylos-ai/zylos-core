import { Sanitizer } from '../sanitizer.js';

const sanitizer = new Sanitizer('');
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);

export function fenceLabel(reason) {
  return { ttl: 'TTL', evict: '驱逐', upgrade: '升级', model_config: '配置', manual_restart: '手工重启', mode_switch: '模式切换', auth: '认证' }[reason];
}

export function waitingReason(row, { runtimeHealth = {}, activations = [], now = Date.now() }) {
  const queue = row.queue;
  if (queue.known !== false && row.fence != null) return { kind: 'fenced', fenceReason: row.fence.reason ?? 'mode_switch', since: row.fence.createdAt };
  const starting = () => ({ kind: 'starting', since: row.createdAt });
  if (queue.known === false) return row.presence === 'starting' ? starting() : { kind: 'unknown', reason: 'queue_summary_failed', pendingKnown: false };
  if (queue.pending.count === 0) return row.presence === 'starting' ? starting() : null;
  const runtime = row.target.runtime;
  if (runtime == null) return { kind: 'unknown', reason: row.target.reason };
  const record = runtimeHealth[runtime];
  const health = record?.source === 'missing' ? 'ok' : record?.health;
  if (health == null) return { kind: 'unknown', reason: 'runtime_health_unreadable' };
  if (health === 'auth_failed') return { kind: 'auth_wait', runtime };
  if (['rate_limited', 'recovering'].includes(health)) return { kind: 'rate_wait', runtime, cooldownUntil: record.cooldownUntil };
  if (health !== 'ok') return { kind: 'unknown', reason: 'no_rule', health };
  if (row.presence === 'starting') return starting();
  if (row.presence === 'not_running') {
    const events = activations.filter(event => event.session_group === row.sessionGroup && timestamp(event.timestamp) >= now - 1800000 && timestamp(event.timestamp) <= now)
      .sort((a, b) => timestamp(b.timestamp) - timestamp(a.timestamp) || (b.event_seq ?? 0) - (a.event_seq ?? 0));
    const last = events[0];
    if (last && ['activate_failed', 'activate_timeout'].includes(last.event_type)) return {
      kind: 'start_failed', count30m: events.filter(event => ['activate_failed', 'activate_timeout'].includes(event.event_type)).length,
      lastAt: last.timestamp, reasonCode: sanitizer.safeSummary(last.metadata?.reason) };
    return { kind: 'unknown', reason: 'pool_capacity_missing' };
  }
  if (row.presence === 'running' && row.live.status.valid && row.live.status.state === 'busy') return { kind: 'queued' };
  return { kind: 'unknown', reason: 'no_rule' };
}
