import { BOOLEAN, listFailure, parseListQuery } from '../list-query.js';
import { DASHBOARD_RUNTIMES } from '../runtime-api.js';
import { validKey, fallbackName } from './display-names.js';
import { validNamespace } from '../../../../comm-bridge/scripts/c4-session-group.js';
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

// Historical group names remain readable when proven by the instance's C4 catalog.
// Live status, queue rows and filesystem paths alone do not establish membership.
export function requireGroupReadShape(id) {
  if (id === 'origin' || validKey(id)) return false;
  const colon = typeof id === 'string' ? id.indexOf(':') : -1;
  const name = colon > 0 ? id.slice(colon + 1) : '';
  if (typeof id !== 'string' || id.length > 128 || !validNamespace(id.slice(0, colon))
    || !name || name.length > 95 || name === '.' || name === '..'
    || /[\u0000-\u001f\u007f/\\]/.test(name)) groupKey(id);
  return true;
}

function requireReadMembership(id, snapshot) {
  if (snapshot.sources?.c4?.ok !== true) throw failure('GROUP_CATALOG_UNREADABLE', 'Session group catalog could not be read', 502);
  if (!snapshot.groupEvidence?.catalog?.has(id)) groupKey(id);
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
  const runtime = row.presence === 'starting' ? null : row.target?.runtime ?? row.live?.runtime ?? null;
  const healthRuntime = row.presence === 'starting' ? row.live?.runtime ?? null : runtime;
  const health = snapshot.instance?.runtimeHealth?.[healthRuntime];
  if (kind === 'working' || flags.queued) {
    if (['auth_failed', 'rate_limited', 'recovering'].includes(health?.health)) flags.blocked = {
      reason: health.health === 'auth_failed' ? 'auth_failed' : 'rate_limited', runtime: healthRuntime,
      recoveryAt: Number.isFinite(health.cooldownUntil) && health.cooldownUntil * 1000 > now ? iso(health.cooldownUntil * 1000) : null,
    };
    else if (health?.source === 'unreadable' || (healthRuntime !== null && health && health.health == null)) errors.push('runtime_health_unreadable');
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
  const runtimeOverridden = snapshot.overrides ? (evidence?.runtimeOverrides
    ? evidence.runtimeOverrides.has(id) : snapshot.overrides.runtime.some(item => item.sessionGroup === id)) : null;
  const savedModel = snapshot.overrides ? (evidence?.modelsByGroup
    ? evidence.modelsByGroup.get(id)?.has(runtime) === true
    : snapshot.overrides.model.some(item => item.sessionGroup === id && item.runtime === runtime)) : null;
  const modelOverridden = launched && !row.launchConfig ? null
    : row.launchConfig?.mode === 'override' || (row.desired?.mode === 'override' && row.desired.runtime === runtime)
      || savedModel;
  return { ...row, id, channel: row.c4?.componentName ?? (id === 'origin' ? null : id.split(':')[0]),
    displayName: row.name?.displayName ?? row.name?.effectiveName ?? fallbackName(id, row.c4?.componentName),
    runtime, model: row.model ?? (typeof row.target?.model === 'object' ? row.target.model?.model : null),
    state: { kind, since: iso(since), ...(stale ? { stale: true, sampledAt: status.sampledAt } : {}),
      ...(kind === 'unknown' && status?.reason === 'stale' && Number.isFinite(status.sampledAt) && ['busy', 'idle'].includes(status.lastState)
        ? { sampledAt: status.sampledAt, lastState: status.lastState } : {}) }, duration, flags, side: kind === 'offline' ? 'offline' : 'running', runtimeOverridden, modelOverridden,
    lastActivityAt: iso(evidence?.messageTimes?.has(id) ? evidence.messageTimes.get(id) : row.c4?.lastActivityAt),
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
    lastActivityAt: row.lastActivityAt, flags: row.flags,
    runtimeOverridden: row.runtimeOverridden, modelOverridden: row.modelOverridden };
  return row.side === 'offline' ? { ...common, ...(row.runtimeOverridden && { runtime: row.runtime }) } : { ...common,
    runtime: row.runtime ?? null, model: row.model ?? null, state: row.state,
    duration: row.duration ?? null, currentAction: projectCurrentAction(row), mainAgent: row.mainAgent ?? 'unknown', contextPct: row.contextPct ?? null };
}

const projections = new WeakMap();
const compareKeys = (left, right) => {
  if (left[1] === right[1] && left[0] === right[0]) return 0;
  if (left[1] === 'origin') return -1;
  if (right[1] === 'origin') return 1;
  return right[0] - left[0] || (left[1] < right[1] ? -1 : 1);
};

function projection(snapshot) {
  let value = projections.get(snapshot);
  if (!value) {
    const rows = snapshot.rows.map(row => projectGroup(row, snapshot));
    const ordered = rows.map(row => ({ row, item: projectListRow(row), key: [atMillis(row.lastActivityAt) || 0, row.id],
      search: [row.id.toLowerCase(), row.displayName.toLowerCase()] })).sort((a, b) => compareKeys(a.key, b.key));
    value = { rows, ordered, byId: new Map(ordered.map(entry => [entry.row.id, entry])) };
    projections.set(snapshot, value);
  }
  return value;
}

export function groupListRows(snapshot, side, flag) {
  return projection(snapshot).ordered.filter(({ row }) => row.side === side && (!flag || Object.hasOwn(row.flags, flag)))
    .map(({ item }) => item);
}

const listFilters = { side: ['running', 'offline'], flag: FLAGS, runtime: DASHBOARD_RUNTIMES,
  runtimeOverridden: BOOLEAN, modelOverridden: BOOLEAN };
const retiredGroupLists = new Set(['running', 'offline', 'search', 'runtime-overrides']);
function requireCatalog(snapshot) {
  if (snapshot.sources?.c4?.ok === false) throw failure('GROUP_CATALOG_UNREADABLE', 'Session group catalog could not be read', 502);
}

export function groupCounts(snapshot, { allowUnreadable = false } = {}) {
  if (!allowUnreadable) requireCatalog(snapshot);
  const states = Object.fromEntries(STATES.map(key => [key, 0]));
  const flags = Object.fromEntries(FLAGS.map(key => [key, 0]));
  const offline = { total: 0, waitingSlot: 0, startFailed: 0 };
  for (const row of projection(snapshot).rows) {
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
    // Current keys retain their existing empty-data behavior without a catalog read.
    async readKey(id) {
      if (!requireGroupReadShape(id)) return id;
      return requireReadMembership(id, await workbench.getSnapshot());
    },
    counts: async () => groupCounts(await workbench.getSnapshot()),
    async list(params = new URLSearchParams()) {
      const query = parseListQuery('groups', params, { filters: listFilters, q: true, include: ['total'] });
      const snapshot = await workbench.getSnapshot();
      if (snapshot.sources?.c4?.ok === false || snapshot.groupEvidence?.messageOrderKnown === false) {
        throw listFailure(503, 'unavailable', 'Session group catalog could not be read');
      }
      const { side, flag, runtime, runtimeOverridden, modelOverridden } = query.filters;
      const text = query.q?.toLowerCase();
      let listKnown = snapshot.listKnown === true;
      const matches = projection(snapshot).ordered.filter(({ row, search }) => {
        if ((side && row.side !== side) || (flag && !Object.hasOwn(row.flags, flag))
          || (runtime && (row.presence !== 'running' || row.runtime !== runtime))
          || (text && !search.some(value => value.includes(text)))) return false;
        if (runtimeOverridden !== undefined) {
          if (row.runtimeOverridden === null) listKnown = false;
          if (row.runtimeOverridden !== runtimeOverridden) return false;
        }
        if (modelOverridden !== undefined) {
          if (row.modelOverridden === null) listKnown = false;
          if (row.modelOverridden !== modelOverridden) return false;
        }
        return true;
      });
      if (runtimeOverridden !== undefined && !snapshot.overrides) listKnown = false;
      if (modelOverridden !== undefined && !snapshot.overrides) listKnown = false;
      const remaining = query.after ? matches.filter(({ key }) => compareKeys(key, query.after) > 0) : matches;
      const page = remaining.slice(0, query.limit);
      return { readAt: snapshot.readAt, listKnown, items: page.map(({ item }) => item),
        nextCursor: remaining.length > query.limit ? query.nextCursor(page.at(-1).key) : null,
        ...(query.include.has('total') ? { total: matches.length } : {}) };
    },
    async activity(params) {
      const ids = (params.get('ids') ?? '').split(',').map(id => id.trim());
      if (ids.length > 100 || ids.some(id => !id)) throw failure('INVALID_IDS', 'ids must contain 1 to 100 group IDs');
      return workbench.activity(params.get('range') || '6h', ids);
    },
    async detail(id, params = new URLSearchParams()) {
      if (retiredGroupLists.has(id)) throw listFailure(404, 'not_found', 'Session group not found');
      // Origin is an Operations Interface with its existing optional parts and defaults.
      let include;
      if (id === 'origin') {
        include = new Set(params.has('include') ? params.get('include').split(',').filter(Boolean) : ['raw', 'config']);
        if ([...include].some(part => !['raw', 'config'].includes(part))) throw failure('INVALID_INCLUDE', 'Include must contain raw or config');
      } else {
        ({ include } = parseListQuery('groups', params, { paging: false, include: ['raw', 'config'] }));
      }
      const historical = requireGroupReadShape(id);
      const snapshot = await workbench.getSnapshot();
      if (historical) requireReadMembership(id, snapshot);
      const entry = projection(snapshot).byId.get(id);
      if (!entry) {
        requireCatalog(snapshot);
        if (id === 'origin') throw failure('GROUP_NOT_FOUND', 'Session group not found', 404);
        throw listFailure(404, 'not_found', 'Session group not found');
      }
      const { item } = entry;
      const projected = entry.row;
      const row = id === 'origin' ? { ...projected, lastActivityAt: iso(projected.c4?.lastActivityAt),
        modelOverridden: ['running', 'starting'].includes(projected.presence)
          ? projected.launchConfig ? projected.launchConfig.mode === 'override' : null : projected.modelOverridden } : projected;
      const readExtra = async (name, read) => {
        if (!include.has(name)) return {};
        try { return { [name]: await read() }; }
        catch (error) { return { [name]: null, [name + 'Error']: { code: error.code ?? 'READ_FAILED', message: error.message ?? 'Observation unavailable' } }; }
      };
      const [raw, config] = await Promise.all([
        readExtra('raw', async () => (await workbench.raw(id, snapshot)).raw),
        readExtra('config', async () => {
          const config = await groupConfig?.get(id);
          if (!config) return null;
          const models = snapshot.groupEvidence?.modelsByGroup;
          const saved = models ? [...(models.get(id)?.values() ?? [])] : snapshot.overrides?.model.filter(item => item.sessionGroup === id);
          const modelOverrides = snapshot.overrides ? saved.map(({ runtime, model, effort }) => ({ runtime, model, effort })) : null;
          return { ...config, modelOverrides };
        }),
      ]);
      const selected = ['running', 'starting'].includes(row.presence) ? row.launchConfig : row.target;
      return { ...row, currentAction: item.currentAction ?? projectCurrentAction(row), readAt: snapshot.readAt, ...raw, ...config, runtimeInfo: getRuntimeInfo(row),
        effective: { runtime: row.runtime, model: row.model ?? selected?.model?.model ?? (typeof selected?.model === 'string' && selected.model !== 'default' ? selected.model : null),
          effort: row.effort ?? selected?.effort ?? selected?.model?.effort ?? null,
          runtimeOverridden: row.runtimeOverridden, modelOverridden: row.modelOverridden },
        run: row.live ? { runId: row.live.runId, sessionId: row.live.sessionId, createdAt: row.createdAt == null ? null : iso(row.createdAt * 1000) } : null };
    },
  };
}
