import { validKey, fallbackName } from './display-names.js';
import { Sanitizer } from '../sanitizer.js';
import { redactQuerySecrets } from './group-merge.js';
import { STALE_STATUS_DISPLAY_MS } from './group-state.js';

const STATES = ['working', 'idle', 'starting', 'stopping', 'unknown'];
const FLAGS = ['queued', 'blocked', 'waitingSlot', 'startFailed', 'unreadable', 'noResponse'];
const atMillis = value => typeof value === 'number' ? value : Date.parse(value);
const iso = value => {
  const timestamp = atMillis(value);
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? new Date(timestamp).toISOString() : null;
};
const failure = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const sanitizer = new Sanitizer('');

export function groupKey(id) {
  if (id !== 'origin' && !validKey(id)) throw failure('SESSION_GROUP_INVALID', 'Invalid session group');
  return id;
}

/** Project independent lifecycle, activity and queue observations without giving
 * a waiting condition precedence over work which is actually running. */
export function projectGroup(row, snapshot) {
  const now = snapshot.readAt, status = row.live?.status;
  const stale = row.presence === 'running' && status?.valid !== true && status?.reason === 'stale' &&
    ['busy', 'idle'].includes(status.lastState) && Number.isFinite(status.sampledAt) &&
    now >= status.sampledAt && now - status.sampledAt < STALE_STATUS_DISPLAY_MS;
  const activity = status?.valid ? status.state : stale ? status.lastState : null;
  const errors = [];
  if (row.presence === 'unknown' || row.live?.error || snapshot.sources?.status?.ok === false) {
    errors.push(row.live?.error?.code ?? row.reason ?? snapshot.sources?.status?.reason ?? 'status_unreadable');
  }
  let kind;
  if (errors.length) kind = 'unknown';
  else if (row.presence === 'not_running') kind = 'offline';
  else if (row.presence === 'starting') kind = 'starting';
  else if (row.presence === 'running' && row.fence) kind = 'stopping';
  else if (row.presence === 'running' && ['busy', 'idle'].includes(activity)) {
    kind = row.working?.on || activity === 'busy' ? 'working' : 'idle';
  } else {
    kind = 'unknown'; errors.push(status?.reason ?? 'activity_unreadable');
  }
  const flags = {};
  const pending = row.queue?.known === false ? null : row.queue?.pending;
  if (pending?.count > 0) flags.queued = { count: pending.count, oldestAt: iso(pending.oldestAt),
    waitSeconds: Number.isFinite(atMillis(pending.oldestAt)) ? Math.max(0, (now - atMillis(pending.oldestAt)) / 1000) : null };
  if (row.queue?.known === false) errors.push(row.queue.reason ?? 'queue_summary_failed');
  const runtime = row.target?.runtime ?? row.live?.runtime ?? null;
  const health = snapshot.instance?.runtimeHealth?.[runtime];
  if (kind === 'working' || flags.queued) {
    if (['auth_failed', 'rate_limited', 'recovering'].includes(health?.health)) flags.blocked = {
      reason: health.health === 'auth_failed' ? 'auth_failed' : 'rate_limited', runtime,
      recoveryAt: Number.isFinite(health.cooldownUntil) && health.cooldownUntil > 0 ? iso(health.cooldownUntil * 1000) : null,
    };
    else if (health?.source === 'unreadable' || (runtime !== null && health && health.health == null)) errors.push('runtime_health_unreadable');
  }
  const pool = snapshot.instance?.pool, evidence = snapshot.groupEvidence;
  const position = evidence?.positions?.get(row.sessionGroup) ?? (row.wait?.kind === 'pool_wait' ? row.wait.position : null);
  if (kind === 'offline' && flags.queued && pool?.capacity != null && pool?.used != null &&
      pool.used >= pool.capacity && !row.fence && !evidence?.owners?.has(row.sessionGroup) && position != null) {
    flags.waitingSlot = { position };
  }
  const failed = (evidence?.activations ?? []).filter(event => event.session_group === row.sessionGroup &&
    ['activate_failed', 'activate_timeout'].includes(event.event_type) && atMillis(event.timestamp) >= now - 1800000 && atMillis(event.timestamp) <= now)
    .sort((a, b) => atMillis(b.timestamp) - atMillis(a.timestamp) || (b.event_seq ?? 0) - (a.event_seq ?? 0));
  if (failed.length) flags.startFailed = { count: failed.length, lastAt: iso(failed[0].timestamp), reason: sanitizer.safeSummary(failed[0].metadata?.reason) };
  else if (row.wait?.kind === 'start_failed') flags.startFailed = {
    count: row.wait.count30m, lastAt: iso(row.wait.lastAt), reason: row.wait.reasonCode ?? null,
  };
  if (Number.isFinite(row.noResponse?.since)) flags.noResponse = { since: iso(row.noResponse.since) };
  if (errors.length) flags.unreadable = { reasons: [...new Set(errors)] };
  const since = kind === 'working' ? row.working?.since
    : kind === 'starting' ? row.createdAt == null ? null : row.createdAt * 1000
      : kind === 'stopping' ? row.fence?.createdAt == null ? null : row.fence.createdAt * 1000 : null;
  const duration = Number.isFinite(since) ? Math.max(0, (now - since) / 1000)
    : kind === 'idle' ? (stale ? status.lastIdleSeconds : status.idleSeconds) ?? null : kind === 'working' ? row.duration ?? null : null;
  const id = row.sessionGroup ?? 'origin';
  const launched = ['running', 'starting'].includes(row.presence);
  const runtimeOverridden = launched
    ? typeof runtime === 'string' && snapshot.baselineRuntime != null ? runtime !== snapshot.baselineRuntime : null
    : snapshot.overrides ? snapshot.overrides.runtime.some(item => item.sessionGroup === row.sessionGroup) : null;
  const modelOverridden = launched ? row.launchConfig ? row.launchConfig.mode === 'override' : null
    : snapshot.overrides ? snapshot.overrides.model.some(item => item.sessionGroup === row.sessionGroup && item.runtime === runtime) : null;
  return { ...row, id, channel: row.c4?.componentName ?? (id === 'origin' ? null : id.split(':')[0]),
    displayName: row.name?.displayName ?? row.name?.effectiveName ?? fallbackName(id, row.c4?.componentName),
    runtime, model: row.model ?? (typeof row.target?.model === 'object' ? row.target.model?.model : null),
    state: { kind, since: iso(since), ...(stale ? { stale: true, sampledAt: status.sampledAt } : {}) }, duration, flags, side: kind === 'offline' ? 'offline' : 'running', runtimeOverridden, modelOverridden,
    lastActivityAt: iso(row.c4?.lastActivityAt),
    ...(kind === 'offline' ? {} : { mainAgent: row.presence === 'running' && ['busy', 'idle'].includes(activity) ? activity : 'unknown' }) };
}

/** Compact action uses already collected safe observations, never tool arguments or raw messages. */
export function projectCurrentAction(row) {
  const summary = value => typeof value === 'string' ? sanitizer.safeSummary(redactQuerySecrets(value), 120) : null;
  return { tool: summary(row.tools?.[0]?.name), message: summary(row.preview?.text), receivedAt: iso(row.preview?.timestamp) };
}

/** List resources expose presentation observations only. Raw evidence belongs
 * to detail, even when a caller already has the complete collected snapshot. */
export function projectListRow(row) {
  const common = { id: row.id, displayName: row.displayName, channel: row.channel,
    lastActivityAt: row.lastActivityAt, flags: row.flags };
  return row.side === 'offline' ? common : { ...common,
    runtime: row.runtime ?? null, model: row.model ?? null, state: row.state,
    duration: row.duration ?? null, currentAction: projectCurrentAction(row), mainAgent: row.mainAgent ?? 'unknown', contextPct: row.contextPct ?? null };
}

function rowsOf(snapshot) { return snapshot.rows.map(row => projectGroup(row, snapshot)); }
function requireCatalog(snapshot) {
  if (snapshot.sources?.c4?.ok === false) throw failure('GROUP_CATALOG_UNREADABLE', 'Session group catalog could not be read', 502);
}

export function groupCounts(snapshot, { allowUnreadable = false } = {}) {
  if (!allowUnreadable) requireCatalog(snapshot);
  const states = Object.fromEntries(STATES.map(key => [key, 0]));
  const flags = Object.fromEntries(FLAGS.map(key => [key, 0]));
  const offline = { total: 0, waitingSlot: 0, startFailed: 0 };
  for (const row of rowsOf(snapshot)) {
    if (row.side === 'offline') {
      offline.total++;
      if (row.flags.waitingSlot) offline.waitingSlot++;
      if (row.flags.startFailed) offline.startFailed++;
    } else {
      states[row.state.kind]++;
      for (const key of FLAGS) if (row.flags[key]) flags[key]++;
    }
  }
  return { readAt: snapshot.readAt, listKnown: snapshot.listKnown === true && snapshot.sources?.c4?.ok !== false,
    running: { total: Object.values(states).reduce((sum, count) => sum + count, 0), states, flags }, offline,
    pool: snapshot.instance?.pool ? { used: snapshot.instance.pool.used ?? null, capacity: snapshot.instance.pool.capacity ?? null } : null };
}

/** Object APIs reuse the existing request snapshot; no second poller or cache. */
export function createGroupsApi({ workbench, groupConfig, getRuntimeInfo = () => null } = {}) {
  return {
    counts: async () => groupCounts(await workbench.getSnapshot()),
    async running() {
      const snapshot = await workbench.getSnapshot();
      return { readAt: snapshot.readAt, listKnown: snapshot.listKnown, rows: rowsOf(snapshot).filter(row => row.side === 'running').map(projectListRow) };
    },
    async offline(params = new URLSearchParams()) {
      const limitText = params.get('limit') ?? '50';
      if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 200) throw failure('INVALID_LIMIT', 'Limit must be between 1 and 200');
      const limit = Number(limitText), q = (params.get('q') ?? '').trim().toLowerCase();
      if (q.length > 64) throw failure('INVALID_QUERY', 'Query must contain at most 64 characters');
      const flag = params.get('flag');
      if (flag !== null && !FLAGS.includes(flag)) throw failure('INVALID_FLAG', 'Flag must be queued, blocked, waitingSlot, startFailed, unreadable or noResponse');
      const cursor = params.get('cursor');
      let after = null;
      if (cursor) {
        try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch {}
        if (!Array.isArray(after) || after.length !== 2 || !Number.isFinite(after[0]) || typeof after[1] !== 'string') throw failure('INVALID_CURSOR', 'Invalid offline cursor');
      }
      const snapshot = await workbench.getSnapshot();
      requireCatalog(snapshot);
      const rank = row => atMillis(row.lastActivityAt) || 0;
      const rows = rowsOf(snapshot).filter(row => row.side === 'offline' && (!flag || Object.hasOwn(row.flags, flag)) && (!q ||
        `${row.id}\n${row.displayName}`.toLowerCase().includes(q)))
        .sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
      const remaining = after ? rows.filter(row => rank(row) < after[0] || (rank(row) === after[0] && row.id.localeCompare(after[1]) > 0)) : rows;
      const page = remaining.slice(0, limit), last = page.at(-1);
      return { readAt: snapshot.readAt, listKnown: snapshot.listKnown, rows: page.map(projectListRow),
        nextCursor: remaining.length > limit ? Buffer.from(JSON.stringify([rank(last), last.id])).toString('base64url') : null };
    },
    async search(q) {
      if (q instanceof URLSearchParams) q = q.get('q');
      const term = String(q ?? '').trim().toLowerCase();
      if (!term || term.length > 64) return { rows: [], truncated: false };
      const snapshot = await workbench.getSnapshot();
      requireCatalog(snapshot);
      const matches = rowsOf(snapshot).filter(row => `${row.id}\n${row.displayName}`.toLowerCase().includes(term));
      return { rows: matches.slice(0, 50).map(row => ({ ...projectListRow(row), side: row.side })), truncated: matches.length > 50 };
    },
    activity: range => workbench.activity((range instanceof URLSearchParams ? range.get('range') : range) || '6h'),
    async detail(id, { include = ['raw', 'config'] } = {}) {
      if (include instanceof URLSearchParams) include = include.has('include') ? include.get('include').split(',').filter(Boolean) : ['raw', 'config'];
      if (!Array.isArray(include) || include.some(value => !['raw', 'config'].includes(value))) throw failure('INVALID_INCLUDE', 'Include must contain raw or config');
      groupKey(id);
      const snapshot = await workbench.getSnapshot();
      const row = rowsOf(snapshot).find(row => row.id === id);
      if (!row) { requireCatalog(snapshot); throw failure('GROUP_NOT_FOUND', 'Session group not found', 404); }
      const readExtra = async (name, read) => {
        if (!include.includes(name)) return {};
        try { return { [name]: await read() }; }
        catch (error) { return { [name]: null, [name + 'Error']: { code: error.code ?? 'READ_FAILED', message: error.message ?? 'Observation unavailable' } }; }
      };
      const [raw, config] = await Promise.all([
        readExtra('raw', async () => (await workbench.raw(id)).raw),
        readExtra('config', async () => groupConfig ? groupConfig.get(id) : null),
      ]);
      const selected = ['running', 'starting'].includes(row.presence) ? row.launchConfig : row.target;
      return { ...row, readAt: snapshot.readAt, ...raw, ...config, runtimeInfo: getRuntimeInfo(row),
        effective: { runtime: row.runtime, model: row.model ?? selected?.model?.model ?? (typeof selected?.model === 'string' && selected.model !== 'default' ? selected.model : null),
          effort: row.effort ?? selected?.effort ?? selected?.model?.effort ?? null,
          runtimeOverridden: row.runtimeOverridden, modelOverridden: row.modelOverridden },
        run: row.live ? { runId: row.live.runId, sessionId: row.live.sessionId, createdAt: row.createdAt == null ? null : iso(row.createdAt * 1000) } : null };
    },
  };
}
