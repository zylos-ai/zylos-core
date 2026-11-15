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
  const value = snapshot([row]); value.instance.runtimeHealth.claude = { health: 'rate_limited', cooldownUntil: now + 60000 };
  const actual = projectGroup(row, value);
  assert.equal(actual.state.kind, 'working'); assert.equal(actual.mainAgent, 'busy');
  assert.equal(actual.flags.queued.count, 3); assert.equal(actual.flags.queued.waitSeconds, 2);
  assert.equal(actual.flags.blocked.reason, 'rate_limited'); assert.equal(actual.flags.blocked.recoveryAt, new Date(now + 60000).toISOString());
});

test('a subagent or command keeps the group working while its main agent is idle', () => {
  for (const working of [{ on: true, subagents: { count: 1 }, main: null }, { on: true, tools: 1, main: null }]) {
    const row = { ...base(), working };
    const value = projectGroup(row, snapshot([row]));
    assert.equal(value.state.kind, 'working'); assert.equal(value.mainAgent, 'idle');
  }
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
    for (const row of page.rows) { assert.equal(row.state.kind, 'offline'); assert.equal(seen.has(row.id), false); seen.add(row.id); }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 57); assert.equal((await service.running()).rows.length, 1);
  assert.equal((await service.search(new URLSearchParams({ q: 'Named project' }))).rows[0].id, 'telegram:old-01');
  assert.equal((await service.search('work')).rows[0].side, 'running');
  await assert.rejects(service.offline(new URLSearchParams({ cursor: 'broken' })), { code: 'INVALID_CURSOR' });
  await assert.rejects(service.offline(new URLSearchParams({ limit: '0' })), { code: 'INVALID_LIMIT' });
});

test('detail shares its list row and adds one configuration and raw-message read', async () => {
  let rawReads = 0, configReads = 0;
  const row = base(); row.launchConfig = { mode: 'override', runtime: 'claude', model: 'test-model', effort: 'high' };
  row.model = 'test-model';
  const api = createGroupsApi({ workbench: { getSnapshot: async () => snapshot([row]), raw: async key => { rawReads++; assert.equal(key, row.sessionGroup); return { raw: 'First message' }; } },
    groupConfig: { get: async () => { configReads++; return { runtime: { ok: true }, model: { ok: true } }; } } });
  const detail = await api.detail(row.sessionGroup);
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
    assert.equal(child.working.subagents.count, 1);
    const counts = await api.counts(); assert.equal(counts.mode, mode ?? 'single'); assert.equal(counts.offline.total, mode === 'multi' ? 58 : 0);
    assert.equal(running.rows.some(row => row.state.kind === 'offline'), false);
  }
});
