import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStatus } from '../../../../../../cli/lib/status-view.js';
import { createGroupSnapshot } from '../group-snapshot.js';
import { createGroupsApi, projectGroup, groupCounts } from '../groups-api.js';

const now = 1800000000000;
const base = (presence = 'running') => ({ sessionGroup: 'telegram:work', presence, live: {
  runId: 'run', status: { valid: true, state: 'idle', idleSeconds: 12 }, runtime: 'claude' },
  queue: { pending: { count: 0, oldestAt: null }, running: { count: 0 } },
  target: { runtime: 'claude', model: 'default' }, working: { on: false }, c4: { lastActivityAt: now - 1000 } });
const snapshot = rows => ({ rows, readAt: now, mode: 'multi', listKnown: true,
  instance: { runtimeHealth: { claude: { health: 'ok' } }, pool: { capacity: 1, used: 1 } }, sources: { status: { ok: true } } });

test('main work, queued messages and throttling remain independent facts', () => {
  const row = base(); row.live.status.state = 'busy'; row.working = { on: true, since: now - 3000 };
  row.queue.pending = { count: 3, oldestAt: now - 2000 };
  const value = snapshot([row]); value.instance.runtimeHealth.claude = { health: 'rate_limited', cooldownUntil: now / 1000 + 60 };
  const actual = projectGroup(row, value);
  assert.equal(actual.state.kind, 'working'); assert.equal(actual.mainAgent, 'busy');
  assert.equal(actual.flags.queued.count, 3); assert.equal(actual.flags.queued.waitSeconds, 2);
  assert.equal(actual.flags.blocked.reason, 'rate_limited'); assert.equal(actual.flags.blocked.recoveryAt, new Date(now + 60000).toISOString());
  for (const cooldownUntil of [0, -1, now / 1000 - 1, now / 1000, NaN, Infinity, 1e15, 'invalid']) {
    value.instance.runtimeHealth.claude.cooldownUntil = cooldownUntil;
    assert.equal(projectGroup(row, value).flags.blocked.recoveryAt, null);
  }
});

test('a subagent or command keeps the group working while its main agent is idle', () => {
  for (const working of [{ on: true, subagents: { count: 1 }, main: null }, { on: true, tools: 1, main: null }]) {
    const row = { ...base(), working };
    const value = projectGroup(row, snapshot([row]));
    assert.equal(value.state.kind, 'working'); assert.equal(value.mainAgent, 'idle');
  }
});
test('expired status remains unknown while retaining its last observation for the list hint', async () => {
  const row = base(); row.live.status = { valid: false, reason: 'stale', sampledAt: now - 61000, lastState: 'busy' };
  const value = snapshot([row]), service = createGroupsApi({ workbench: { getSnapshot: async () => value } });
  const actual = (await service.running()).rows[0];
  assert.equal(actual.state.kind, 'unknown'); assert.equal(actual.mainAgent, 'unknown');
  assert.equal(actual.state.sampledAt, now - 61000); assert.equal(actual.state.lastState, 'busy');
  assert.equal(Object.hasOwn(actual, 'live'), false); assert.equal(Object.keys(actual).length, 12);
  row.live.status.reason = 'identity_mismatch';
  assert.equal(Object.hasOwn((await service.running()).rows[0].state, 'lastState'), false);
});

test('lifecycle primary states never turn queue or start failures into primary states', () => {
  for (const [presence, fence, valid, expected] of [
    ['running', null, true, 'idle'], ['running', { createdAt: now / 1000 - 2 }, true, 'stopping'],
    ['starting', null, false, 'starting'], ['not_running', null, false, 'offline'], ['unknown', null, false, 'unknown'],
    ['running', null, false, 'unknown'],
  ]) {
    const row = base(presence); row.fence = fence; row.live.status.valid = valid;
    row.wait = { kind: 'start_failed', count30m: 1, lastAt: now - 1000, reasonCode: 'failed' };
    const value = projectGroup(row, snapshot([row]));
    assert.equal(value.state.kind, expected); assert.equal(value.flags.startFailed.count, 1);
    if (expected === 'offline') assert.equal(Object.hasOwn(value, 'mainAgent'), false);
    if (expected === 'unknown') assert.ok(value.flags.unreadable.reasons.length > 0);
  }
});

test('offline pool waiting and recent failures stack and failures survive a later successful start', () => {
  const row = base('not_running'); row.live = null; row.queue.pending = { count: 1, oldestAt: now - 3000 };
  const value = snapshot([row]); value.groupEvidence = { positions: new Map([[row.sessionGroup, 2]]), owners: new Set(), activations: [
    { session_group: row.sessionGroup, event_type: 'activate_failed', timestamp: now - 1000, metadata: { reason: 'sk-123456789012345678901234' } },
    { session_group: row.sessionGroup, event_type: 'activate_new', timestamp: now - 100 },
    { session_group: row.sessionGroup, event_type: 'activate_failed', timestamp: now - 1800001 },
  ] };
  const actual = projectGroup(row, value);
  assert.equal(actual.state.kind, 'offline'); assert.equal(actual.flags.waitingSlot.position, 2);
  assert.equal(actual.flags.startFailed.count, 1); assert.equal(actual.flags.startFailed.reason, '[REDACTED]');
  value.instance.pool.used = 0; assert.equal(projectGroup(row, value).flags.waitingSlot, undefined);
});

test('counts contain numbers and no offline rows; unknown remains on the running side', () => {
  const rows = [base('unknown'), base('running'), ...Array.from({ length: 60 }, (_, index) => ({ ...base('not_running'), sessionGroup: `telegram:old-${index}` }))];
  const result = groupCounts(snapshot(rows));
  assert.equal(result.running.total, 2); assert.equal(result.running.states.unknown, 1); assert.equal(result.offline.total, 60);
  assert.equal(JSON.stringify(result).includes('old-'), false); assert.equal(Object.hasOwn(result.offline, 'rows'), false);
});

test('an unreadable catalog fails counts and offline search instead of reporting an empty catalog', async () => {
  const value = snapshot([base()]); value.sources.c4 = { ok: false };
  const service = createGroupsApi({ workbench: { getSnapshot: async () => value } });
  await assert.rejects(service.counts(), { code: 'GROUP_CATALOG_UNREADABLE', statusCode: 502 });
  await assert.rejects(service.offline(), { code: 'GROUP_CATALOG_UNREADABLE' });
  await assert.rejects(service.search('missing'), { code: 'GROUP_CATALOG_UNREADABLE' });
  assert.equal((await service.running()).rows[0].state.kind, 'idle');
  value.sources.status = { ok: false, reason: 'status_unreadable' }; value.listKnown = false;
  const running = await service.running();
  assert.equal(running.listKnown, false); assert.equal(running.rows[0].state.kind, 'unknown');
});

test('offline pagination and search select names and keys across both sides', async () => {
  const rows = Array.from({ length: 57 }, (_, index) => ({ ...base('not_running'), sessionGroup: `telegram:old-${String(index).padStart(2, '0')}`,
    name: { displayName: index === 1 ? 'Named project' : null }, c4: { lastActivityAt: now - index * 1000 } }));
  rows.unshift(base());
  const service = createGroupsApi({ workbench: { getSnapshot: async () => snapshot(rows) } });
  const seen = new Set(); let cursor = null;
  do {
    const params = new URLSearchParams({ limit: '13', ...(cursor ? { cursor } : {}) });
    const page = await service.offline(params);
    assert.ok(page.rows.length <= 13);
    for (const row of page.rows) { assert.equal(Object.hasOwn(row, 'state'), false); assert.equal(seen.has(row.id), false); seen.add(row.id); }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 57); assert.equal((await service.running()).rows.length, 1);
  assert.equal((await service.search(new URLSearchParams({ q: 'Named project' }))).rows[0].id, 'telegram:old-01');
  assert.equal((await service.search('work')).rows[0].state.kind, 'idle');
  await assert.rejects(service.offline(new URLSearchParams({ cursor: 'broken' })), { code: 'INVALID_CURSOR' });
  await assert.rejects(service.offline(new URLSearchParams({ limit: '0' })), { code: 'INVALID_LIMIT' });
});

test('detail shares its list row and adds one configuration and raw-message read', async () => {
  let rawReads = 0, configReads = 0;
  const row = base(); row.launchConfig = { mode: 'override', runtime: 'claude', model: 'test-model', effort: 'high' };
  row.model = 'test-model';
  row.preview = { text: 'Current received message', timestamp: now - 1000 };
  row.tools = [{ name: 'Read' }];
  const api = createGroupsApi({ workbench: { getSnapshot: async () => snapshot([row]), raw: async key => { rawReads++; assert.equal(key, row.sessionGroup); return { raw: 'First message' }; } },
    groupConfig: { get: async () => { configReads++; return { runtime: { ok: true }, model: { ok: true } }; } } });
  const detail = await api.detail(row.sessionGroup);
  const list = (await api.running()).rows[0];
  assert.deepEqual(detail.currentAction, list.currentAction);
  assert.deepEqual(detail.currentAction, { tool: 'Read', message: 'Current received message', receivedAt: new Date(now - 1000).toISOString() });
  assert.equal(detail.raw, 'First message'); assert.equal(detail.state.kind, 'idle'); assert.equal(detail.effective.effort, 'high');
  assert.equal(detail.effective.modelOverridden, true); assert.equal(rawReads, 1); assert.equal(configReads, 1);
  await assert.rejects(api.detail('telegram:absent'), { statusCode: 404 });
  await assert.rejects(api.detail('../bad'), { code: 'SESSION_GROUP_INVALID' });
});

// Cross-module collection evidence: real Core status and real working reducer,
// injected session/CLI observations in a runner-isolated root. Run for group
// projection/collection changes; skip unrelated rendering edits. No DB, network,
// tmux, runtime or PM2 is opened; the root is removed after this case.
test('real snapshot projects child-only work and an old offline catalog in both modes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok(root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Group API isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, root, tmux: 'none', database: 'none', network: 'none' }));
  for (const mode of ['multi', 'single', null]) {
    const key = mode === 'multi' ? 'telegram:child' : null;
    const catalog = Array.from({ length: 57 }, (_, index) => ({ sessionGroup: `telegram:old-${index}`, lastActivityAt: now - 9 * 86400000 }));
    const observation = { identity: { present: true, ready: true, runId: 'run', runtime: 'claude', createdAt: now / 1000 - 10, launchConfig: { runtime: 'claude', mode: 'default' } },
      status: { valid: true, sampledAt: now, value: { state: 'idle' } }, usage: { valid: false } };
    const events = [{ session_group: key, run_id: 'run', event_type: 'subagent_start', timestamp: new Date(now - 1000).toISOString(), metadata: { agent_id: 'child' } }];
    const reader = { readSessionState: async group => group === key ? observation : { identity: { present: false }, status: { valid: false }, usage: { valid: false } }, readAccountUsage: async () => ({}) };
    const service = createGroupSnapshot({ zylosDir: root, now: () => now,
      cli: { runC4Db: async args => ({ ok: true, data: args[0] === 'groups' ? catalog : { groups: [], globalFence: null } }),
        readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) },
      store: { latestEventByType: () => null, queryEvents: filter => events.filter(event => (!filter.types || filter.types.includes(event.event_type)) &&
        (filter.sessionGroup === undefined || filter.sessionGroup === event.session_group) && (filter.runId === undefined || filter.runId === event.run_id)) },
      c4Reader: { listSlotOccupancy: () => [] },
      loadCoreModule: async name => {
        if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
        if (name === 'session-state-reader.js') return reader;
        if (name === 'session-pool-config.js') return { readPoolCapacity: () => ({ k: 3, valid: true, fresh: true }) };
        if (name === 'status-view.js') return { collectStatus: options => collectStatus({ ...options, mode: () => ({ mode }),
          list: () => [{ sessionGroup: key }], now: () => now, resolveRoot: () => root, configIssue: () => null,
          requests: () => [], facts: () => ({ originNeed: null }), health: () => ({ missing: true }) }) };
        throw new Error(`Unexpected module ${name}`);
      } });
    const api = createGroupsApi({ workbench: service });
    const running = await api.running(), child = running.rows.find(row => row.id === (key ?? 'origin'));
    assert.equal(child.state.kind, 'working'); assert.equal(child.mainAgent, 'idle');
    assert.equal((await api.detail(child.id, { include: [] })).working.subagents.count, 1);
    assert.equal(Object.hasOwn(child, 'working'), false);
    const counts = await api.counts(); assert.equal(Object.hasOwn(counts, 'mode'), false); assert.equal(counts.offline.total, mode === 'multi' ? 58 : 0);
    assert.equal(running.rows.some(row => row.state.kind === 'offline'), false);
  }
});

test('running status keeps its last main-agent state for the established stale display window', () => {
  for (const lastState of ['busy', 'idle']) {
    const row = base(); row.live.status = { valid: false, reason: 'stale', lastState, sampledAt: now - 6000, lastIdleSeconds: 17 };
    const value = projectGroup(row, snapshot([row]));
    assert.equal(value.state.kind, lastState === 'busy' ? 'working' : 'idle');
    assert.equal(value.state.stale, true); assert.equal(value.state.sampledAt, now - 6000); assert.equal(value.mainAgent, lastState);
    assert.equal(value.flags.unreadable, undefined);
    if (lastState === 'idle') assert.equal(value.duration, 17);
    row.live.status.sampledAt = now - 60000;
    assert.equal(projectGroup(row, snapshot([row])).state.kind, 'unknown');
    assert.equal(projectGroup(row, snapshot([row])).mainAgent, 'unknown');
  }
});

test('detail can omit expensive extras and reports each optional read failure without losing state', async () => {
  let reads = 0; const row = base();
  const api = createGroupsApi({ workbench: { getSnapshot: async () => snapshot([row]), raw: async () => { reads++; throw new Error('Raw unavailable'); } },
    groupConfig: { get: async () => { reads++; throw new Error('Config unavailable'); } } });
  const fast = await api.detail(row.sessionGroup, { include: new URLSearchParams({ include: '' }) });
  assert.equal(fast.state.kind, 'idle'); assert.equal(reads, 0); assert.equal(Object.hasOwn(fast, 'raw'), false); assert.equal(Object.hasOwn(fast, 'config'), false);
  const full = await api.detail(row.sessionGroup);
  assert.equal(full.state.kind, 'idle'); assert.equal(reads, 2); assert.equal(full.raw, null); assert.equal(full.config, null);
  assert.equal(full.rawError.code, 'READ_FAILED'); assert.equal(full.configError.code, 'READ_FAILED');
  await assert.rejects(api.detail(row.sessionGroup, { include: new URLSearchParams({ include: 'bad' }) }), { code: 'INVALID_INCLUDE' });
});

test('stream and self-fleet counts can retain known rows when only the catalog is unreadable', () => {
  const value = snapshot([base()]); value.sources.c4 = { ok: false }; value.instance.pool.capacityRecord = { source: 'fixture' };
  assert.throws(() => groupCounts(value), { code: 'GROUP_CATALOG_UNREADABLE' });
  const counts = groupCounts(value, { allowUnreadable: true });
  assert.equal(counts.listKnown, false); assert.equal(counts.running.total, 1); assert.deepEqual(counts.pool, { used: 1, capacity: 1 });
});

const RUNNING_FIELDS = ['id', 'displayName', 'channel', 'runtime', 'model', 'state', 'duration', 'flags', 'mainAgent', 'contextPct', 'lastActivityAt', 'currentAction'].sort();
const OFFLINE_FIELDS = ['id', 'displayName', 'channel', 'lastActivityAt', 'flags'].sort();

test('list resources expose only their compact fields while detail retains source observations', async () => {
  const active = { ...base(), contextPct: 35, tools: [{ name: 'Bash' }], launchConfig: { runtime: 'claude', mode: 'default' },
    secretObservation: { source: 'not a list field' } };
  const sleeping = { ...base('not_running'), sessionGroup: 'telegram:offline', working: null, live: null };
  const api = createGroupsApi({ workbench: { getSnapshot: async () => snapshot([active, sleeping]) } });
  const running = (await api.running()).rows[0];
  assert.deepEqual(Object.keys(running).sort(), RUNNING_FIELDS);
  assert.equal(running.contextPct, 35);
  const offline = (await api.offline()).rows[0];
  assert.deepEqual(Object.keys(offline).sort(), OFFLINE_FIELDS);
  const search = await api.search('telegram:');
  assert.equal(search.rows.length, 2);
  for (const row of search.rows) assert.deepEqual(Object.keys(row).sort(), [...(row.id === active.sessionGroup ? RUNNING_FIELDS : OFFLINE_FIELDS), 'side'].sort());
  const detail = await api.detail(active.sessionGroup, { include: [] });
  for (const field of ['presence', 'live', 'working', 'queue', 'target', 'launchConfig', 'c4', 'tools', 'secretObservation']) assert.deepEqual(detail[field], active[field]);
  const counts = await api.counts();
  assert.equal(Object.hasOwn(counts, 'mode'), false);
  assert.deepEqual(Object.keys(counts.pool).sort(), ['capacity', 'used']);
});

test('offline flag filtering combines with text search before stable pagination', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ ...base('not_running'), live: null,
    sessionGroup: `telegram:failed-${index}`, name: { displayName: index === 5 ? 'Other' : 'Target' },
    wait: index === 0 ? null : { kind: 'start_failed', count30m: index, lastAt: now - 100, reasonCode: 'launch_failed' },
    c4: { lastActivityAt: now - index * 1000 } }));
  const api = createGroupsApi({ workbench: { getSnapshot: async () => snapshot(rows) } });
  const query = { flag: 'startFailed', q: 'target', limit: '2' };
  const first = await api.offline(new URLSearchParams(query));
  assert.deepEqual(first.rows.map(row => row.id), ['telegram:failed-1', 'telegram:failed-2']);
  assert.ok(first.nextCursor);
  const second = await api.offline(new URLSearchParams({ ...query, cursor: first.nextCursor }));
  assert.deepEqual(second.rows.map(row => row.id), ['telegram:failed-3', 'telegram:failed-4']);
  assert.equal(second.nextCursor, null);
  assert.equal((await api.offline(new URLSearchParams({ flag: 'queued' }))).rows.length, 0);
  for (const flag of ['', 'start_failed', 'startFailed,queued']) await assert.rejects(api.offline(new URLSearchParams({ flag })), { code: 'INVALID_FLAG', statusCode: 400 });
  assert.equal((await api.offline(new URLSearchParams({ flag: 'startFailed' }))).rows.length, 5);
});


test('compact current action bounds and redacts names and message excerpts without exposing raw observations', async () => {
  const row = { ...base(), tools: [{ name: 'Bash', input: 'private-command', detail: 'private-detail' }],
    preview: { text: 'https://example.test/?token=private-secret ' + 'x'.repeat(200), timestamp: now - 1000, messageRaw: 'private-raw' } };
  const api = createGroupsApi({ workbench: { getSnapshot: async () => snapshot([row]) } });
  const active = (await api.running()).rows[0];
  assert.deepEqual(Object.keys(active.currentAction).sort(), ['message', 'receivedAt', 'tool']);
  assert.equal(active.currentAction.tool, 'Bash');
  assert.equal(active.currentAction.receivedAt, new Date(now - 1000).toISOString());
  assert.equal(active.currentAction.message.length, 120);
  assert.ok(active.currentAction.message.includes('[REDACTED]'));
  assert.doesNotMatch(JSON.stringify(active), /private-secret|private-command|private-detail|private-raw/);
  const empty = (await createGroupsApi({ workbench: { getSnapshot: async () => snapshot([base()]) } }).running()).rows[0];
  assert.deepEqual(empty.currentAction, { tool: null, message: null, receivedAt: null });
});

test('existing no-response observation is an independent ISO flag counted on the running side', async () => {
  const active = { ...base(), noResponse: { since: now - 125000 } };
  const offline = { ...base('not_running'), sessionGroup: 'telegram:offline', noResponse: { since: now - 1000 } };
  const value = snapshot([active, offline]);
  const api = createGroupsApi({ workbench: { getSnapshot: async () => value } });
  assert.deepEqual((await api.running()).rows[0].flags.noResponse, { since: new Date(now - 125000).toISOString() });
  assert.equal((await api.counts()).running.flags.noResponse, 1);
  assert.equal((await api.offline(new URLSearchParams({ flag: 'noResponse' }))).rows[0].id, offline.sessionGroup);
  active.noResponse = null;
  assert.equal((await api.counts()).running.flags.noResponse, 0);
  assert.equal((await api.running()).rows[0].flags.noResponse, undefined);
});
