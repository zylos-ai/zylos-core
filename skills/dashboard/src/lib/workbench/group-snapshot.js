import { readThresholdPolicy, sessionThreshold } from '../session-threshold.js';
import { loadCoreModule as defaultLoadCoreModule } from '../core-modules.js';
import { Sanitizer } from '../sanitizer.js';
import { createCoreCli } from './core-cli.js';
import { mergeGroups } from './group-merge.js';
import { waitingReason } from './waiting-reason.js';
import { classify, durationOf, sortRows, countRows } from './group-state.js';
import { buildAttention, createChannelDownCounter } from './attention.js';
import { activityBuckets } from './activity-buckets.js';
import { searchGroups } from './group-search.js';

const emptyNames = { listAll: () => new Map(), search: () => [] };
const activationTypes = ['activate_new', 'start_always', 'activate_failed', 'activate_timeout'];
const activityLookbackLimit = 200;
const activityTypes = ['pre_tool_use', 'post_tool_use', 'post_tool_failure', 'user_prompt_submit', 'stop',
  'permission_request', 'wait_health', 'wait_capacity', 'activate_failed', 'activate_timeout', 'session_start',
  'activate_new', 'start_always', 'adopt_ready', 'reclaim_done', 'rotate_done', 'crash_detected', 'subagent_start', 'subagent_stop'];

function queryAllEvents(store, filter) {
  const events = [];
  for (let offset = 0; ; offset += 1000) {
    const page = store.queryEvents({ ...filter, limit: 1000, offset, order: 'asc' });
    events.push(...page);
    if (page.length < 1000) return events;
  }
}

/** No timers: collection happens only in response to a read request. */
export function createGroupSnapshot({ zylosDir, store, c4Reader, loadCoreModule = defaultLoadCoreModule,
  now = Date.now, cli = createCoreCli({ zylosDir }), sanitizer = new Sanitizer(zylosDir),
  displayNames = emptyNames, readConfigRuntime = () => null, channelDownCounter = createChannelDownCounter(),
  readPm2 = () => null } = {}) {
  let cache = null, inflight = null, accountsCache = null;
  const activities = new Map();
  async function getSnapshot(at = now()) {
    if (inflight) return inflight;
    if (cache && at - cache.builtAt < 2000) return cache.value;
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
        const observation = await reader.readSessionState(group, options);
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
    const { rows, hasOlder } = mergeGroups({ status, c4, q, names: await displayNames.listAll(), statusError }, sanitizer);
    const ov = await cli.readOverrides([...new Set([...rows.map(row => row.sessionGroup).filter(group => group !== null), 'origin'])]);
    sources.ov = source(ov);
    let baselineRuntime = null;
    if (ov.ok) baselineRuntime = ov.data.baseline.runtime;
    else { try { baselineRuntime = await readConfigRuntime() ?? null; } catch {} }
    const sample = store.latestEventByType('pool_sample')?.metadata;
    const pool = Object.fromEntries(['ready', 'starting', 'reclaiming', 'waiting'].map(key => [key, sample?.[key] ?? null]));
    pool.capacity = null; pool.used = pool.ready === null ? null : pool.ready + pool.starting;
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
      row.wait = waitingReason(row, { runtimeHealth, activations, now: at });
      row.state = classify(row, { statusError });
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
    const value = { readAt: at, mode, view: status?.view ?? null, rows, counts: countRows(rows), hasOlder,
      listKnown: status !== null && status.groupListError === null, baselineRuntime,
      instance: { runtimeHealth: status?.runtimeHealth ?? null, accounts: accountsCache.accounts, pool, services },
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
      since: new Date(start).toISOString(), until: new Date(at).toISOString(), types: activityTypes }));
    const runs = new Map(keys.map(key => [key, new Set()]));
    for (const row of snapshot.rows) if (row.live?.runId && runs.has(row.sessionGroup)) runs.get(row.sessionGroup).add(row.live.runId);
    for (const event of events) if (event.run_id != null) runs.get(event.session_group)?.add(event.run_id);
    for (const [sessionGroup, runIds] of runs) for (const runId of runIds) {
      const filter = { sessionGroup, runId, until: new Date(start - 1).toISOString(), order: 'desc' };
      const prompt = store.queryEvents({ ...filter, types: ['user_prompt_submit'], limit: 1 })[0];
      const stop = store.queryEvents({ ...filter, types: ['stop'], limit: 1 })[0];
      // Match the reducer's source-time ordering, with insertion order for ties.
      const turn = !prompt ? stop : !stop ? prompt
        : (Date.parse(prompt.timestamp) - Date.parse(stop.timestamp) || prompt.event_seq - stop.event_seq) > 0
          ? prompt : stop;
      if (turn) events.push(turn);
      // An open turn already covers tools. Stop supplies a fallback tool end;
      // the reducer still prefers a matching end after stop. Capped lookback
      // omits pre-stop tools, so that overlap may be absent at the window edge.
      // No timestamp floor from an earlier ingested event: source times may
      // arrive out of order. afterSeq uses the Store's insertion ordering.
      if (turn?.event_type !== 'user_prompt_submit') events.push(...store.queryEvents({ ...filter,
        types: ['pre_tool_use', 'post_tool_use', 'post_tool_failure'],
        ...(turn ? { afterSeq: turn.event_seq } : {}), limit: activityLookbackLimit }));
      // Stop does not close subagents. Pair their own starts/ends separately.
      // The run index bounds scans to this run; caps bound returned rows, not
      // scans within a long run. Starts older than 200 matching events can be
      // omitted, so this display can under-report very old outstanding work.
      events.push(...store.queryEvents({ ...filter, types: ['subagent_start', 'subagent_stop'], limit: activityLookbackLimit }));
    }
    let inbound = [], inboundError = false;
    try { if (keys.length) inbound = c4Reader.getInboundTimes({ since: start, groups: keys }); }
    catch { inboundError = true; }
    const value = activityBuckets({ range, now: at, rows: snapshot.rows, events, inbound });
    if (inboundError) return { ...value, inboundError: 'inbound_unreadable' };
    activities.set(range, { at: now(), value });
    return value;
  }
  return { getSnapshot, getCachedSnapshot: () => cache?.value ?? null, activity, channelDownCounter,
    search: (q, at = now()) => searchGroups(q, { now: at, runC4Db: cli.runC4Db, getSnapshot, displayNames, sanitizer }) };
}

function source({ ok, reason, detail, readAt }) { return { ok, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), readAt }; }

/** Shared by the HTTP routes; authentication is owned by the existing API gate. */
export async function workbenchResponse(service, pathname, searchParams) {
  if (pathname === '/api/workbench/groups') {
    const snapshot = await service.getSnapshot();
    return searchParams.get('view') === 'summary' ? { readAt: snapshot.readAt, mode: snapshot.mode,
      view: snapshot.view, counts: snapshot.counts, pool: { used: snapshot.instance.pool.used, capacity: snapshot.instance.pool.capacity }, hasOlder: snapshot.hasOlder } : snapshot;
  }
  if (pathname === '/api/workbench/groups/search') return service.search(searchParams.get('q'));
  if (pathname === '/api/workbench/activity') return service.activity(searchParams.get('range'));
  return null;
}
