import { readThresholdPolicy, sessionThreshold } from '../session-threshold.js';
import { loadCoreModule as defaultLoadCoreModule } from '../core-modules.js';
import { Sanitizer } from '../sanitizer.js';
import { createCoreCli } from './core-cli.js';
import { mergeGroups, previewTaskIds, safeRaw } from './group-merge.js';
import { readTaskNames as defaultReadTaskNames } from './schedule-read.js';
import { waitingReason } from './waiting-reason.js';
import { classify, durationOf, sortRows, countRows } from './group-state.js';
import { buildAttention, createChannelDownCounter } from './attention.js';
import { activityBuckets } from './activity-buckets.js';
import { workingHistory, END_TYPES, TOOL_TYPES, CHILD_TYPES } from './working.js';
const { resolveSessionHotTtl } = await defaultLoadCoreModule('session-hot-ttl.js');
import { searchGroups } from './group-search.js';
import { validKey } from './display-names.js';
import { readPool, poolPositions } from './pool-capacity.js';

const emptyNames = { listAll: () => new Map(), search: () => [] };
const activationTypes = ['activate_new', 'start_always', 'activate_failed', 'activate_timeout'];
const activityLookbackLimit = 200;


function queryAllEvents(store, filter) {
  const events = [];
  for (let offset = 0; ; offset += 1000) {
    const page = store.queryEvents({ ...filter, limit: 1000, offset, order: 'asc' });
    events.push(...page);
    if (page.length < 1000) return events;
  }
}

const finiteOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** The host's latest CPU, memory and disk sample with its collection time; the page judges its age against readAt. */
export function systemSample(sample) {
  if (!sample || typeof sample !== 'object' || !Number.isFinite(sample.collectedAt)) return null;
  return { sampledAt: sample.collectedAt, cpuPct: finiteOrNull(sample.cpu_pct), cpuCount: finiteOrNull(sample.cpu_count),
    memUsedBytes: finiteOrNull(sample.mem_used_bytes), memTotalBytes: finiteOrNull(sample.mem_total_bytes),
    diskUsedPct: finiteOrNull(sample.disk_used_pct), diskFreeBytes: finiteOrNull(sample.disk_free_bytes) };
}

/** No timers: collection happens only in response to a read request. */
export function createGroupSnapshot({ zylosDir, store, c4Reader, loadCoreModule = defaultLoadCoreModule,
  now = Date.now, cli = createCoreCli({ zylosDir }), sanitizer = new Sanitizer(zylosDir),
  displayNames = emptyNames, readConfigRuntime = () => null, channelDownCounter = createChannelDownCounter(),
  readPm2 = () => null, readSystem = () => null, readTaskNames = ids => defaultReadTaskNames(zylosDir, ids) } = {}) {
  let cache = null, inflight = null, accountsCache = null;
  const activities = new Map();
  let hotTtlMs = 1800000;
  async function namesOfTasks(items) {
    const ids = previewTaskIds(items);
    if (!ids.length) return new Map();
    try { return await readTaskNames(ids); } catch { return new Map(); }
  }
  async function getSnapshot(at = now(), { fresh = false } = {}) {
    if (inflight) {
      if (!fresh) return inflight;
      // A lifecycle-triggered reader needs observations made after the pending
      // read, rather than reusing an old generation's in-flight snapshot.
      await inflight;
      return getSnapshot(at, { fresh });
    }
    if (!fresh && cache && at - cache.builtAt < 2000) return cache.value;
    inflight = buildGroupSnapshot(at);
    try {
      const value = await inflight;
      cache = { value, builtAt: now() };
      return value;
    } finally { inflight = null; }
  }
  async function buildGroupSnapshot(at) {
    const captured = new Map(), sources = {};
    let mode = 'unreadable', status = null, statusError = null, reader;
    try { mode = (await loadCoreModule('config.js')).readSessionMode().mode; }
    catch { mode = 'unreadable'; }
    try {
      reader = await loadCoreModule('session-state-reader.js');
      const { collectStatus } = await loadCoreModule('status-view.js');
      status = await collectStatus({ session: async (group, options) => {
        // Context use stays the session's last sample however long it has been idle; the run and session
        // identity checks still apply. The status sample keeps the status view's own freshness.
        const observation = await reader.readSessionState(group, { ...options, usageFreshnessMs: Infinity });
        captured.set(group, observation);
        return observation;
      } });
      sources.status = { ok: true, readAt: now() };
    } catch {
      statusError = 'status_unreadable';
      sources.status = { ok: false, reason: statusError, readAt: now() };
    }
    const [c4, q] = await Promise.all([
      cli.runC4Db(['groups', '--active-since', String(at - 7 * 86400000), '--json']),
      cli.runC4Db(['group-queues', '--json']),
    ]);
    sources.c4 = source(c4); sources.q = source(q);
    const taskNames = c4.ok ? await namesOfTasks(c4.data.groups) : new Map();
    const { rows, hasOlder } = mergeGroups({ status, c4, q, names: await displayNames.listAll(), taskNames, statusError }, sanitizer);
    const ov = await cli.readOverrides([...new Set([...rows.map(row => row.sessionGroup).filter(group => group !== null), 'origin'])]);
    sources.ov = source(ov);
    let baselineRuntime = null;
    if (ov.ok) baselineRuntime = ov.data.baseline.runtime;
    else { try { baselineRuntime = await readConfigRuntime() ?? null; } catch {} }
    const sample = store.latestEventByType('pool_sample')?.metadata;
    const { occupancy, ...pool } = await readPool({ mode, now: at, sample, c4Reader, loadCoreModule });
    const activations = queryAllEvents(store, { since: new Date(at - 30 * 60000).toISOString(), types: activationTypes });
    if (!accountsCache || at - accountsCache.at >= 30000) {
      const accounts = {}, accountSources = {};
      if (!reader) { try { reader = await loadCoreModule('session-state-reader.js'); } catch {} }
      await Promise.all(['claude', 'codex'].map(async runtime => {
        try {
          const sample = await reader.readAccountUsage(runtime, { allowRecorded: true });
          const weekly = sample?.value?.seven_day ?? sample?.value?.sevenDay;
          accounts[runtime] = weekly ? { ...weekly, recordedAt: sample.recordedAt, live: sample.live } : null;
          accountSources[runtime] = { ok: true, readAt: now() };
        } catch {
          accounts[runtime] = null;
          accountSources[runtime] = { ok: false, reason: 'account_usage_unreadable', readAt: now() };
        }
      }));
      accountsCache = { at: now(), accounts, sources: accountSources };
    }
    sources.accounts = accountsCache.sources;
    const runtimeHealth = status?.runtimeHealth ?? {};
    const thresholdPolicy = readThresholdPolicy(zylosDir);
    hotTtlMs = resolveSessionHotTtl(thresholdPolicy.config).seconds * 1000;
    for (const row of rows) {
      const observation = captured.get(row.sessionGroup);
      row.createdAt = observation?.identity.createdAt ?? null;
      row.launchConfig = observation?.identity.launchConfig ?? null;
      row.tools = observation?.status.valid && Array.isArray(observation.status.value.active_tool_details) ? observation.status.value.active_tool_details.map(tool => ({
        id: tool.id, name: tool.name, detail: sanitizer.sanitizeToolDetail(tool.name, tool.input), startedAt: tool.startedAt,
      })) : [];
      const usage = observation?.usage;
      row.contextPct = usage?.valid ? usage.value.context_window?.used_percentage ??
        (usage.value.contextUsage?.ceiling > 0 ? usage.value.contextUsage.used / usage.value.contextUsage.ceiling * 100 : null) : null;
      if (observation && !usage?.valid) row.contextReason = 'usage_unreadable';
      row.queue = q.ok ? q.data.groups.find(item => item.sessionGroup === row.sessionGroup) ??
        { pending: { count: 0, oldestAt: null, head: null }, running: { count: 0 }, fence: null } : { known: false, reason: q.reason };
      row.fence = row.queue.known === false ? null : row.queue.fence ?? q.data.globalFence;
      const selectedRuntime = ov.ok ? ov.data.runtime.find(item => item.sessionGroup === row.sessionGroup)?.runtime ?? ov.data.baseline.runtime : null;
      const selectedModel = ov.ok ? ov.data.model.find(item => item.sessionGroup === row.sessionGroup && item.runtime === selectedRuntime) : null;
      row.target = ['running', 'starting'].includes(row.presence)
        ? { runtime: observation?.identity.runtime ?? row.live?.runtime ?? null, model: !row.launchConfig ? null : row.launchConfig.mode === 'override'
          ? { model: row.launchConfig.model, effort: row.launchConfig.effort } : 'default',
          ...(row.launchConfig ? {} : { reason: 'launch_config_unreadable' }) }
        : ov.ok ? { runtime: selectedRuntime, model: selectedModel ? { model: selectedModel.model, effort: selectedModel.effort } : 'default' }
          : { runtime: null, reason: 'override_list_failed' };
      if (status?.view === 'single') row.target.onlyMulti = true;
      row.desired = status?.view === 'single' || !ov.ok ? null : selectedModel
        ? { runtime: selectedRuntime, mode: 'override', model: selectedModel.model, effort: selectedModel.effort }
        : { runtime: selectedRuntime, mode: 'default' };
      const running = ['running', 'starting'].includes(row.presence);
      row.rotationThreshold = observation?.status?.reason === 'identity_changed' ? null : sessionThreshold(thresholdPolicy, { runtime: row.target.runtime,
        usage: usage?.valid ? usage.value : null, launchConfig: row.launchConfig,
        ...(running ? {} : { desiredModel: selectedModel?.model ?? thresholdPolicy.defaultModels[row.target.runtime] }) });
    }
    const positions = poolPositions(rows, occupancy);
    const owners = new Set((occupancy ?? []).map(slot => slot.sessionGroup));
    for (const row of rows) {
      row.wait = waitingReason(row, { runtimeHealth, activations, now: at, pool,
        position: positions.get(row.sessionGroup), ownsSlot: owners.has(row.sessionGroup) });
      row.state = classify(row, { statusError, now: at });
      row.working = null;
      if (row.presence === 'running' && row.live?.runId && sources.status.ok === true) {
        const filter = { sessionGroup: row.sessionGroup, runId: row.live.runId,
          until: new Date(at).toISOString(), sourceTime: true, order: 'desc' };
        const prompt = store.queryEvents({ ...filter, types: ['user_prompt_submit'], agentScope: 'main', limit: 1 });
        const end = store.queryEvents({ ...filter, types: END_TYPES, agentScope: 'main', limit: 1 });
        const children = store.queryEvents({ ...filter, types: CHILD_TYPES, agentScope: 'child', limit: activityLookbackLimit });
        const childTools = store.queryEvents({ ...filter, types: TOOL_TYPES, agentScope: 'child', latestPerAgent: true, limit: activityLookbackLimit });
        // The main-turn TTL also needs ANY event, including assistant/permission events.
        // Keep transitions separate and retain each child's own latest tool time.
        const latest = store.queryEvents({ ...filter, limit: 1 });
        const events = [...prompt, ...end, ...children, ...childTools, ...latest];
        row.working = workingHistory(events, at, { ttlMs: hotTtlMs, tools: row.tools.length }).working;
      }
      const events = row.state.kind === 'busy' && row.live?.runId ? queryAllEvents(store, {
        sessionGroup: row.sessionGroup, runId: row.live.runId, types: ['user_prompt_submit', 'stop'], until: new Date(at).toISOString(),
      }) : [];
      row.duration = durationOf(row, { now: at, events });
    }
    let pm2Data = null;
    try {
      const sample = readPm2();
      if (Array.isArray(sample?.processes) && sample.processes.every(process => process !== null && typeof process === 'object')) pm2Data = sample;
    } catch { /* an unreadable service sample stays unknown */ }
    const services = pm2Data ? { online: pm2Data.processes.filter(process => process.pm2_env?.status === 'online').length,
      total: pm2Data.processes.length } : null;
    let system = null;
    try { system = systemSample(readSystem()); } catch { /* an unreadable host sample stays unknown */ }
    const value = { readAt: at, mode, view: status?.view ?? null, rows, counts: countRows(rows), hasOlder,
      listKnown: status !== null && status.groupListError === null, baselineRuntime,
      instance: { runtimeHealth: status?.runtimeHealth ?? null, accounts: accountsCache.accounts, pool, services, system },
      overrides: ov.ok ? ov.data : null, sources };
    value.attention = buildAttention(value, { channelDownCounter, pm2Data });
    for (const row of rows) row.attention = value.attention.problems.filter(problem =>
      problem.group === row.sessionGroup || problem.groups?.includes(row.sessionGroup));
    value.rows = sortRows(rows);
    return value;
  }
  async function activity(range, at = now()) {
    if (!['60m', '6h'].includes(range)) throw Object.assign(new Error('Invalid range'), { code: 'invalid_range', statusCode: 400 });
    const prior = activities.get(range);
    if (prior && at - prior.at < 30000) return prior.value;
    const snapshot = await getSnapshot(at), keys = snapshot.rows.map(row => row.sessionGroup).filter(key => key !== null);
    const width = range === '60m' ? 60000 : 300000, size = range === '60m' ? 60 : 72;
    const start = Math.floor(at / width) * width - (size - 1) * width;
    const events = keys.flatMap(sessionGroup => queryAllEvents(store, { sessionGroup,
      since: new Date(start).toISOString(), until: new Date(at).toISOString(), sourceTime: true }));
    const runs = new Map(keys.map(key => [key, new Set()]));
    for (const row of snapshot.rows) if (row.live?.runId && runs.has(row.sessionGroup)) runs.get(row.sessionGroup).add(row.live.runId);
    for (const event of events) if (event.run_id != null) runs.get(event.session_group)?.add(event.run_id);
    for (const [sessionGroup, runIds] of runs) for (const runId of runIds) {
      const filter = { sessionGroup, runId, until: new Date(start - 1).toISOString(), sourceTime: true, order: 'desc' };
      // Seed by source time, not insertion order: late ingestion must not hide a newer transition.
      events.push(...store.queryEvents({ ...filter, types: ['user_prompt_submit'], agentScope: 'main', limit: 1 }));
      events.push(...store.queryEvents({ ...filter, types: END_TYPES, agentScope: 'main', limit: 1 }));
      events.push(...store.queryEvents({ ...filter, limit: 1 }));
      // Keep starts independent of tool volume, and seed each child's own latest
      // tool so noisy siblings cannot evict its freshness at the window edge.
      events.push(...store.queryEvents({ ...filter, types: TOOL_TYPES, agentScope: 'main', limit: activityLookbackLimit }));
      events.push(...store.queryEvents({ ...filter, types: CHILD_TYPES, agentScope: 'child', limit: activityLookbackLimit }));
      events.push(...store.queryEvents({ ...filter, types: TOOL_TYPES, agentScope: 'child', latestPerAgent: true, limit: activityLookbackLimit }));
    }
    let inbound = [], inboundError = false;
    try { if (keys.length) inbound = c4Reader.getInboundTimes({ since: start, groups: keys }); }
    catch { inboundError = true; }
    const value = activityBuckets({ range, now: at, rows: snapshot.rows, events, inbound, ttlMs: hotTtlMs });
    if (inboundError) return { ...value, inboundError: 'inbound_unreadable' };
    activities.set(range, { at: now(), value });
    return value;
  }
  // One group's stored message start, read only when someone opens it in the technical view. Key search puts the
  // exact key first; a first row with another key means the group was not found.
  async function raw(key) {
    const result = await cli.runC4Db(['groups', '--key-match', key, '--limit', '1', '--raw', '--json']);
    if (!result.ok) throw Object.assign(new Error('Group read failed'), { statusCode: 502, code: 'group_raw_failed', reason: 'c4_groups_failed' });
    return { raw: safeRaw(result.data.find(item => item.sessionGroup === key)?.preview?.messageRaw, sanitizer) };
  }
  return { getSnapshot, getCachedSnapshot: () => cache?.value ?? null, activity, channelDownCounter, raw,
    search: (q, at = now()) => searchGroups(q, { now: at, runC4Db: cli.runC4Db, getSnapshot, displayNames, sanitizer, namesOfTasks }) };
}

function source({ ok, reason, detail, readAt }) { return { ok, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), readAt }; }

const WORKBENCH_RAW = /^\/api\/workbench\/groups\/([^/]+)\/raw$/;

/** Shared by the HTTP routes; authentication is owned by the existing API gate. */
export async function workbenchResponse(service, pathname, searchParams) {
  if (pathname === '/api/workbench/groups') {
    const snapshot = await service.getSnapshot();
    return searchParams.get('view') === 'summary' ? { readAt: snapshot.readAt, mode: snapshot.mode,
      view: snapshot.view, counts: snapshot.counts, pool: { used: snapshot.instance.pool.used, capacity: snapshot.instance.pool.capacity }, hasOlder: snapshot.hasOlder } : snapshot;
  }
  if (pathname === '/api/workbench/groups/search') return service.search(searchParams.get('q'));
  if (pathname === '/api/workbench/activity') return service.activity(searchParams.get('range'));
  const raw = pathname.match(WORKBENCH_RAW);
  if (raw) {
    let key;
    try { key = decodeURIComponent(raw[1]); } catch {}
    if (key !== 'origin' && !validKey(key)) throw Object.assign(new Error('Invalid session group'), { statusCode: 400, code: 'SESSION_GROUP_INVALID' });
    return service.raw(key);
  }
  return null;
}
