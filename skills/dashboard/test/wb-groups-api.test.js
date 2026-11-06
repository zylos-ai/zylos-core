import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { collectStatus } from '../../../cli/lib/status-view.js';
import { createGroupSnapshot, workbenchResponse } from '../src/lib/workbench/group-snapshot.js';
import { createCoreCli } from '../src/lib/workbench/core-cli.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { AuthGate } from '../src/lib/auth.js';
import { Store } from '../src/lib/store.js';

function fixture(t, { count = 1, statusError = false, modeError = false, overrideError = false,
  c4Error = false, queueError = false, groupListError = false, noSample = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snapshot-'));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); fs.rmSync(root, { recursive: true, force: true }); });
  let clock = 1800000000000, mode = 'multi', unexpected = false, configRuntime = 'codex', configFailure = false, healthRecord = { missing: true };
  const calls = [], observations = [], events = [], reads = [];
  const keys = Array.from({ length: count }, (_, index) => `telegram:g${index}`);
  const live = new Map(keys.map(key => [key, { identity: { present: true, ready: true, runtime: 'claude', runId: `run-${key}`,
    createdAt: clock / 1000 - 10, launchConfig: { runtime: 'claude', mode: 'default' } },
    status: { valid: true, sampledAt: clock, value: { state: 'busy', active_tool_details: [{ id: 'T', name: 'Bash', input: { command: 'echo sk-123456789012345678901234' } }] } },
    usage: { valid: false } }]));
  const reader = { readSessionState: async key => {
    observations.push(key);
    return live.get(key) ?? { identity: { present: false }, status: { valid: false, reason: 'not_running' }, usage: { valid: false } };
  }, readAccountUsage: async runtime => {
    reads.push(runtime); if (runtime === 'codex') throw new Error('unreadable');
    return { seven_day: { used_percentage: 23 }, five_hour: { used_percentage: 99 } };
  } };
  const cli = { runC4Db: async args => {
    calls.push(args);
    if (args[0] === 'groups') return c4Error ? { ok: false, reason: 'c4_groups_failed', detail: 'timeout', readAt: clock }
      : { ok: true, readAt: clock, data: { groups: keys.map(sessionGroup => ({ sessionGroup, componentName: 'telegram', sessionGroupName: sessionGroup.slice(9), lastActivityAt: clock,
        preview: { text: 'sk-123456789012345678901234', timestamp: clock } })), hasOlder: true } };
    return queueError ? { ok: false, reason: 'queue_summary_failed', readAt: clock }
      : { ok: true, readAt: clock, data: { groups: [], globalFence: null } };
  }, readOverrides: async groups => {
    calls.push(['overrides', ...groups]);
    return overrideError ? { ok: false, reason: 'override_list_failed', readAt: clock }
      : { ok: true, readAt: clock, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } };
  } };
  const store = { latestEventByType: () => noSample ? null : { metadata: { ready: 1, starting: 2, reclaiming: 3, waiting: 4 } },
    queryEvents: filter => {
      if (unexpected) throw new Error('Unexpected storage failure');
      events.push(filter); return [];
    } };
  const c4Reader = { getInboundTimes: () => [] };
  const service = createGroupSnapshot({ zylosDir: root, store, cli, now: () => clock,
    c4Reader, readConfigRuntime: () => { if (configFailure) throw new Error('config'); return configRuntime; }, loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => { if (modeError) throw new Error('config'); return { mode }; } };
      if (name === 'session-state-reader.js') return reader;
      return { collectStatus: options => {
        if (statusError) throw new Error('status');
        return collectStatus({ ...options, mode: () => ({ mode }), now: () => clock, resolveRoot: () => root,
          list: () => { if (groupListError) throw new Error('list'); return keys.map(sessionGroup => ({ sessionGroup })); },
          health: () => healthRecord });
      } };
    } });
  return { service, root, calls, observations, live, reads, events, reader, cli, store, c4Reader,
    addCleanup: close => cleanup.push(close),
    setHealth: value => { healthRecord = value; }, setConfigRuntime: value => { configRuntime = value; }, failConfig: value => { configFailure = value; },
    setNow: value => { clock = value; }, advance: value => { clock += value; }, setMode: value => { mode = value; },
    failUnexpected: value => { unexpected = value; }, now: () => clock };
}

// Integration: Cross-module snapshot/cache boundary; run for collection or cache changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('snapshot shares in-flight collection, caches from completion, and captures each live observation once', async t => {
  const f = fixture(t), initial = f.cli.runC4Db;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.cli.runC4Db = async args => { await held; return initial(args); };
  const first = f.service.getSnapshot(), second = f.service.getSnapshot();
  await new Promise(resolve => setImmediate(resolve));
  f.advance(3000); const third = f.service.getSnapshot();
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(results[0], results[1]); assert.equal(results[0], results[2]);
  assert.equal(f.calls.length, 3); assert.equal(f.observations.length, 2);
  assert.deepEqual(f.calls.find(args => args[0] === 'groups'), ['groups', '--active-since', String(1800000000000 - 7 * 86400000), '--json']);
  assert.equal(f.calls.filter(args => args.includes('--key-match')).length, 0);
  f.advance(1000); assert.equal(await f.service.getSnapshot(), results[0]); assert.equal(f.calls.length, 3);
  f.advance(1100); await f.service.getSnapshot(); assert.equal(f.calls.length, 6);
  assert.equal(f.reads.length, 2, 'weekly account cache survives snapshot expiry');
  f.advance(30000); await f.service.getSnapshot(); assert.equal(f.reads.length, 4);
});

// Integration: Cross-module failure/retry boundary; run for snapshot error handling changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('unexpected build failure does not poison cache or the next request', async t => {
  const f = fixture(t); f.failUnexpected(true);
  await assert.rejects(f.service.getSnapshot(), /Unexpected storage failure/);
  f.failUnexpected(false); const value = await f.service.getSnapshot();
  assert.equal(value.rows.length, 2); assert.equal(f.calls.length, 6);
});

// Integration: Cross-module response/privacy boundary; run for snapshot or response changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('full and summary responses preserve metadata-only C4 and redact messages and tools', async t => {
  const f = fixture(t), value = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams());
  assert.equal(value.listKnown, true); assert.equal(value.baselineRuntime, 'claude');
  assert.equal(value.instance.pool.used, 3); assert.equal(value.instance.pool.capacity, null);
  assert.equal(value.instance.accounts.claude.used_percentage, 23); assert.equal(value.instance.accounts.codex, null);
  assert.equal(JSON.stringify(value).includes('five_hour'), false);
  assert.equal(value.sources.accounts.codex.reason, 'account_usage_unreadable');
  const row = value.rows.find(item => item.sessionGroup === 'telegram:g0');
  assert.deepEqual(Object.keys(row.c4).sort(), ['componentName', 'lastActivityAt', 'sessionGroupName']);
  assert.equal(row.contextReason, 'usage_unreadable'); assert.equal(row.contextPct, null);
  assert.equal(JSON.stringify(value).includes('sk-123456789012345678901234'), false);
  assert.match(row.preview.text, /REDACTED/); assert.match(row.tools[0].detail, /REDACTED/);
  const summary = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams('view=summary'));
  assert.deepEqual(Object.keys(summary).sort(), ['counts', 'hasOlder', 'mode', 'pool', 'readAt', 'view']);
  assert.deepEqual(summary.pool, { used: 3, capacity: null });
});

// Integration: Cross-module absent-sample boundary; run for pool projection changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('empty pool samples are valid snapshots and summaries with unknown occupancy', async t => {
  const f = fixture(t, { noSample: true });
  const value = await f.service.getSnapshot(); assert.equal(value.instance.pool.used, null);
  const summary = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams('view=summary'));
  assert.deepEqual(summary.pool, { used: null, capacity: null });
});

// Integration: per-source failure projection; run for snapshot source/error changes;
// skip rendering-only edits. Owned temporary roots, injected adapters, no live
// tmux/PM2/network; fixture cleanup is registered for every table case.
for (const failure of ['statusError', 'modeError', 'c4Error', 'queueError', 'overrideError', 'groupListError']) {
  test(`snapshot reports ${failure} without fabricating successful values`, async t => {
    const f = fixture(t, { [failure]: true }), value = await f.service.getSnapshot();
    if (failure === 'modeError') assert.equal(value.mode, 'unreadable');
    if (failure === 'statusError') {
      assert.ok(value.rows.every(row => row.state.kind === 'unknown'));
      assert.ok(value.attention.problems.some(item => item.source === 'status_unreadable'));
    }
    if (failure === 'c4Error') { assert.equal(value.hasOlder, null); assert.equal(value.sources.c4.reason, 'c4_groups_failed'); }
    if (failure === 'queueError') assert.ok(value.rows.every(row => row.queue.known === false));
    if (failure === 'overrideError') {
      assert.equal(value.baselineRuntime, 'codex'); assert.equal(value.overrides, null);
      assert.equal(value.rows.find(row => row.sessionGroup === 'origin').target.runtime, null);
    }
    if (failure === 'groupListError') assert.equal(value.listKnown, false);
  });
}

// Integration: Cross-module single-view boundary; run for view or activity query changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('single view has one null-key row and never queries activity events for it', async t => {
  const f = fixture(t); f.setMode('single');
  const value = await f.service.getSnapshot();
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].sessionGroup, null); assert.equal(value.hasOlder, null);
  assert.equal(value.rows[0].desired, null);
  f.events.length = 0; const activity = await f.service.activity('60m');
  assert.equal(f.events.length, 0); assert.deepEqual(activity.groups, {});
});

test('Core CLI uses bounded argv children, exact envelopes, and serial current-row override batches', async () => {
  const calls = []; let active = 0, peak = 0;
  const cli = createCoreCli({ zylosDir: '/isolated/zylos', env: { PATH: '/fixture', ZYLOS_SESSION_GROUP: 'old' },
    execute: async (file, argv, options) => {
      calls.push({ file, argv, options }); active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--;
      const secondBatch = calls.length === 3;
      return { stdout: JSON.stringify({ ok: true, data: {
        baseline: { runtime: secondBatch ? 'claude' : 'codex' },
        runtime: calls.length === 2 ? [{ sessionGroup: 'tg:g0', runtime: 'claude' }] : [],
        model: secondBatch ? [{ sessionGroup: 'tg:g499', runtime: 'codex', model: 'selected', effort: 'high' }] : [],
      } }) };
    } });
  await cli.runC4Db(['groups', '--active-since', '1', '--json']);
  assert.equal(calls[0].file, process.execPath);
  assert.equal(calls[0].argv[0], '/isolated/zylos/.claude/skills/comm-bridge/scripts/c4-db.js');
  assert.equal(calls[0].options.timeout, 15000); assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  assert.equal(calls[0].options.env.ZYLOS_DIR, '/isolated/zylos');
  assert.equal(Object.hasOwn(calls[0].options.env, 'ZYLOS_SESSION_GROUP'), false);
  const groups = ['origin', ...Array.from({ length: 500 }, (_, i) => `tg:g${i}`)];
  const result = await cli.readOverrides([...groups, null]);
  assert.equal(result.ok, true); assert.equal(calls.length, 3); assert.equal(peak, 1);
  const requested = calls.slice(1).flatMap(call => call.argv.filter((value, i, all) => all[i - 1] === '--group'));
  assert.equal(requested.length, 501); assert.equal(new Set(requested).size, 501);
  assert.equal(requested.includes(null), false); assert.equal(calls[2].argv.filter(v => v === '--group').length, 1);
  assert.deepEqual(result.data.baseline, { runtime: 'codex' });
  assert.deepEqual(result.data.runtime, [{ sessionGroup: 'tg:g0', runtime: 'claude' }]);
  assert.deepEqual(result.data.model, [{ sessionGroup: 'tg:g499', runtime: 'codex', model: 'selected', effort: 'high' }]);
});

for (const kind of ['non_json', 'false', 'throw']) test(`Core source failure is explicit: ${kind}`, async () => {
  const cli = createCoreCli({ zylosDir: '/isolated', execute: async () => {
    if (kind === 'throw') throw Object.assign(new Error('failure'), { code: 'ETIMEDOUT' });
    return { stdout: kind === 'non_json' ? 'broken' : JSON.stringify({ ok: false, error: { code: 'BROKEN' } }) };
  } });
  const result = await cli.runC4Db(['group-queues', '--json']);
  assert.equal(result.ok, false); assert.equal(result.reason, 'queue_summary_failed');
  assert.equal((await cli.readOverrides([])).reason, 'override_list_failed');
});

test('any failed override batch rejects the whole source, including baseline', async () => {
  let calls = 0;
  const cli = createCoreCli({ zylosDir: '/isolated', execute: async () => ({ stdout: JSON.stringify(++calls === 2
    ? { ok: false, error: { code: 'BROKEN' } } : { ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) }) });
  const value = await cli.readOverrides(Array.from({ length: 501 }, (_, i) => `tg:g${i}`));
  assert.equal(value.ok, false); assert.equal(value.reason, 'override_list_failed'); assert.equal('data' in value, false);
});

// Read-only integration: private SQLite fixture, no tmux/PM2/network. Run for
// activity source filtering or read SQL changes; skip unrelated UI edits. Close
// reader before comparing and removing only owned fixture files.
test('inbound activity reads only active external inbound rows without changing C4 bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-inbound-')), dir = path.join(root, 'comm-bridge');
  fs.mkdirSync(dir); const file = path.join(dir, 'c4.db'), db = new Database(file);
  db.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT,direction TEXT,channel TEXT,timestamp TEXT)');
  const insert = db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)');
  for (const [id, group, direction, channel] of [[1, 'tg:a', 'in', 'telegram'], [2, 'tg:a', 'out', 'telegram'], [3, 'tg:a', 'in', 'internal'], [4, 'tg:old', 'in', 'telegram']]) insert.run(id, group, direction, channel, '2026-01-01 00:00:00');
  db.close(); const before = fs.readFileSync(file), reader = new C4Reader(root);
  t.after(() => { reader.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const rows = reader.getInboundTimes({ since: Date.parse('2026-01-01T00:00:00Z'), groups: ['tg:a'] });
  assert.equal(rows.length, 1); assert.equal(rows[0].session_group, 'tg:a');
  assert.equal(rows[0].timestamp, Date.parse('2026-01-01T00:00:00Z'));
  reader.close(); assert.equal(fs.readFileSync(file).equals(before), true);
});

// Integration: Actual AuthGate plus shared responses; run for API access or dispatch changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('read-scoped API authentication permits new routes while unauthenticated requests are rejected', async t => {
  const token = `zylos_st_${'a'.repeat(64)}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const gate = new AuthGate({ auth: { enabled: true, password: 'configured' } }, {
    getApiSession: key => key === hash ? { api_key_id: 1, scope: 'read', expires_at: Date.now() + 60000, key_revoked_at: null } : null,
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  const service = { getSnapshot: async () => ({ rows: [] }), search: async () => ({ rows: [] }) };
  for (const pathname of ['/api/workbench/groups', '/api/workbench/groups/search']) {
    for (const authorized of [false, true]) {
      const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, getHeader(key) { return this.headers[key]; },
        writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
      const req = { method: 'GET', headers: authorized ? { authorization: `Bearer ${token}` } : {} };
      const handled = await gate.handle(req, res, new URL(`http://fixture${pathname}`));
      if (!handled) { res.status = 200; res.body = JSON.stringify(await workbenchResponse(service, pathname, new URLSearchParams())); }
      assert.equal(res.status, authorized ? 200 : 401);
    }
  }
});

// Integration: Cross-module bounded collection timing; run for snapshot source call changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('thirty live groups produce one bounded on-demand collection with no search command', async t => {
  const f = fixture(t, { count: 30 }), started = performance.now();
  const value = await f.service.getSnapshot(); const duration = performance.now() - started;
  assert.equal(value.rows.length, 31); assert.equal(f.calls.length, 3);
  assert.equal(f.calls.some(args => args.includes('--key-match')), false);
  t.diagnostic(`30-group isolated collection ${duration.toFixed(2)} ms (2000 ms informational budget)`);
});

// Integration: Cross-module live/desired configuration boundary; run for override projection changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('target overrides include row 101 and model-only rows while desired stays distinct from live configuration', async t => {
  const f = fixture(t, { count: 102 });
  f.live.delete('telegram:g100'); f.live.delete('telegram:g2');
  let requested;
  const modelOnly = { sessionGroup: 'telegram:g2', runtime: 'claude', model: 'chosen-model', effort: 'high' };
  f.cli.readOverrides = async groups => {
    requested = groups;
    return { ok: true, data: { baseline: { runtime: 'claude' },
      runtime: [{ sessionGroup: 'telegram:g100', runtime: 'codex' }, { sessionGroup: 'telegram:g0', runtime: 'codex' }, { sessionGroup: 'unlisted-group', runtime: 'codex' }],
      model: [modelOnly, { sessionGroup: 'telegram:g0', runtime: 'codex', model: 'saved-model', effort: 'low' }, { sessionGroup: 'unlisted-group', runtime: 'claude', model: 'unlisted-model', effort: 'high' }] } };
  };
  const value = await f.service.getSnapshot(), rows = new Map(value.rows.map(row => [row.sessionGroup, row]));
  assert.equal(rows.get('telegram:g100').target.runtime, 'codex');
  assert.deepEqual(rows.get('telegram:g2').target.model, { model: modelOnly.model, effort: modelOnly.effort });
  assert.equal(rows.get('telegram:g100').target.model, 'default');
  assert.equal(rows.get('telegram:g0').target.runtime, 'claude');
  assert.deepEqual(rows.get('telegram:g0').desired, { runtime: 'codex', mode: 'override', model: 'saved-model', effort: 'low' });
  assert.equal(requested.length, 103);
  assert.equal(requested.includes('unlisted-group'), false, 'a real override outside all row sources is not queried');
  assert.equal(rows.has('unlisted-group'), false);
});

// Integration: Cross-module failed-source union/baseline boundary; run for source merge changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('all primary sources failing still requests Origin baseline and uses no invented group rows', async t => {
  const f = fixture(t, { statusError: true, c4Error: true, queueError: true }), value = await f.service.getSnapshot();
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].sessionGroup, 'origin');
  assert.deepEqual(f.calls.find(args => args[0] === 'overrides'), ['overrides', 'origin']);
  assert.equal(value.baselineRuntime, 'claude'); assert.equal(value.rows[0].state.reason, 'status_unreadable');
});

// Integration: Cross-module mode/config fallback boundary; run for configuration projection changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('unreadable mode still uses the collected view and bad fallback configuration remains null', async t => {
  const f = fixture(t, { modeError: true }); f.setMode('single');
  const single = await f.service.getSnapshot(); assert.equal(single.mode, 'unreadable');
  assert.equal(single.view, 'single'); assert.equal(single.rows.length, 1);
  const bad = fixture(t, { overrideError: true }); bad.failConfig(true);
  assert.equal((await bad.service.getSnapshot()).baselineRuntime, null);
});

// Integration: Cross-module per-reader failure boundary; run for observation handling changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('a failed per-group reader stays unknown instead of being projected idle', async t => {
  const f = fixture(t), read = f.reader.readSessionState;
  f.reader.readSessionState = key => key === 'telegram:g0' ? Promise.reject(new Error('broken group')) : read(key);
  const row = (await f.service.getSnapshot()).rows.find(item => item.sessionGroup === 'telegram:g0');
  assert.equal(row.state.kind, 'unknown'); assert.equal(row.live.error.code, 'READ_FAILED');
});

// Integration: actual Store with source timestamps arriving out of order. Run for
// duration or event query changes; skip rendering-only edits. Owned fixture DB,
// injected Core/CLI, no live resources; fixture closes Store before cleanup.
test('working duration reads only the current run latest prompt or stop from the real event store', async t => {
  const f = fixture(t), store = new Store(path.join(f.root, 'dashboard.db'));
  f.addCleanup(() => store.close());
  const add = (id, run, kind, before) => store.insertEvent({ id, ingest_id: id, timestamp: new Date(f.now() - before).toISOString(),
    runtime: 'claude', session_group: 'telegram:g0', run_id: run, event_type: kind, category: 'activity' });
  add('old', 'previous', 'user_prompt_submit', 1000);
  add('current', 'run-telegram:g0', 'user_prompt_submit', 6000);
  add('late-old-stop', 'run-telegram:g0', 'stop', 9000);
  const filters = [];
  f.store.queryEvents = filter => { filters.push(filter); return store.queryEvents(filter); };
  let row = (await f.service.getSnapshot()).rows.find(item => item.sessionGroup === 'telegram:g0');
  assert.equal(row.duration, 6);
  assert.ok(filters.some(filter => filter.sessionGroup === 'telegram:g0' && filter.runId === 'run-telegram:g0' && filter.limit === 1000));
  add('stop', 'run-telegram:g0', 'stop', 500);
  add('late-old-prompt', 'run-telegram:g0', 'user_prompt_submit', 7000); f.advance(2100);
  row = (await f.service.getSnapshot()).rows.find(item => item.sessionGroup === 'telegram:g0');
  assert.equal(row.duration, null);
});

// Integration: Cross-module activity pagination/cache boundary; run for activity query/cache changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('activity uses separate thirty-second range caches and reads every active-group event page', async t => {
  const f = fixture(t), filters = [], normal = f.store.queryEvents;
  f.store.queryEvents = filter => {
    if (!filter.types.includes('session_start')) return normal(filter);
    filters.push(filter);
    assert.ok(['origin', 'telegram:g0'].includes(filter.sessionGroup));
    assert.equal(filter.limit, 1000);
    if (filter.sessionGroup === 'origin') return [];
    if (filter.offset === 0) return Array.from({ length: 1000 }, (_, i) => ({ event_seq: i + 1, event_type: 'session_start',
      session_group: 'telegram:g0', run_id: 'history', timestamp: new Date(f.now() - 10000).toISOString(), metadata: {} }));
    return [{ event_seq: 1001, event_type: 'activate_failed', session_group: 'telegram:g0', run_id: 'history', timestamp: new Date(f.now() - 5000).toISOString(), metadata: {} }];
  };
  const minute = await f.service.activity('60m');
  const failedCell = Math.floor((f.now() - 5000 - minute.start) / (minute.cellSeconds * 1000));
  assert.equal(minute.groups['telegram:g0'].cells[failedCell], 'error');
  assert.equal(filters.length, 3);
  f.advance(1000); assert.equal(await f.service.activity('60m'), minute); assert.equal(filters.length, 3);
  const six = await f.service.activity('6h'); assert.equal(six.groups['telegram:g0'].cells.length, 72); assert.equal(filters.length, 6);
  f.advance(30000); await f.service.activity('60m'); assert.equal(filters.length, 9);
  await assert.rejects(f.service.activity('1d'), { code: 'invalid_range', statusCode: 400 });
});

// Full read-only boundary: actual Dashboard Store and C4Reader on owned SQLite
// fixtures; Core readers/CLI are injected read-only adapters. Run for snapshot or
// activity read wiring; skip unrelated rendering. No tmux/PM2/network/children.
// Connections close before root cleanup; compare bytes instead of row diff dumps.
test('full snapshot and activity cycle leaves C4 and Dashboard event storage unchanged', async t => {
  const f = fixture(t), directory = path.join(f.root, 'comm-bridge'); fs.mkdirSync(directory);
  const c4File = path.join(directory, 'c4.db'), writer = new Database(c4File);
  writer.exec("CREATE TABLE conversations(id INTEGER PRIMARY KEY,session_group TEXT,direction TEXT,channel TEXT,timestamp TEXT);INSERT INTO conversations VALUES(1,'telegram:g0','in','telegram','2026-01-01 00:00:00')");
  writer.close();
  const c4 = new Database(c4File, { readonly: true }), reader = new C4Reader(f.root), store = new Store(path.join(f.root, 'dashboard.db'));
  f.addCleanup(() => { reader.close(); c4.close(); store.close(); });
  f.c4Reader.getInboundTimes = options => reader.getInboundTimes(options);
  store.insertEvent({ id: 'initial', ingest_id: 'initial', timestamp: new Date(f.now() - 1000).toISOString(), runtime: 'claude',
    session_group: 'telegram:g0', run_id: 'run-telegram:g0', event_type: 'session_start', category: 'activity' });
  f.store.queryEvents = filter => store.queryEvents(filter);
  f.store.latestEventByType = type => store.latestEventByType(type);
  const cli = f.cli.runC4Db;
  f.cli.runC4Db = async args => { c4.prepare('SELECT id FROM conversations').all(); return cli(args); };
  const beforeC4 = fs.readFileSync(c4File), version = c4.pragma('data_version', { simple: true });
  const eventBytes = () => Buffer.from(JSON.stringify(store.queryEvents({ limit: 1000 })));
  const storageBytes = file => new Map(['', '-wal'].map(suffix => [suffix, fs.existsSync(file + suffix) ? fs.readFileSync(file + suffix) : null]));
  const beforeEvents = eventBytes(), dashboardBytes = storageBytes(path.join(f.root, 'dashboard.db'));
  assert.ok(dashboardBytes.get('-wal')?.length > 0, 'fixture has WAL content to protect');
  await f.service.getSnapshot(); await f.service.activity('60m');
  assert.equal(c4.pragma('data_version', { simple: true }), version);
  assert.equal(fs.readFileSync(c4File).equals(beforeC4), true);
  assert.equal(eventBytes().equals(beforeEvents), true);
  const afterDashboard = storageBytes(path.join(f.root, 'dashboard.db'));
  for (const [suffix, before] of dashboardBytes) {
    const after = afterDashboard.get(suffix);
    assert.equal(before === null ? after === null : after !== null && after.equals(before), true, `Dashboard ${suffix || 'main'} bytes unchanged`);
  }
  assert.equal(f.calls.every(args => ['groups', 'group-queues', 'overrides'].includes(args[0])), true);
});

// Integration: source-envelope and row-enrichment boundaries. Run for Core input,
// privacy or snapshot changes; skip rendering-only changes. Owned temporary roots,
// injected CLI/reader adapters, no live tmux/PM2/network/children; fixture cleanup.
test('snapshot keeps global fences and runtime authentication attention on affected rows', async t => {
  const f = fixture(t), normal = f.cli.runC4Db;
  const globalFence = { reason: null, createdAt: f.now() / 1000 - 20 };
  f.cli.runC4Db = async args => args[0] === 'group-queues'
    ? { ok: true, data: { groups: [], globalFence } } : normal(args);
  f.setHealth({ health: 'auth_failed' });
  const snapshot = await f.service.getSnapshot(), row = snapshot.rows.find(item => item.sessionGroup === 'telegram:g0');
  assert.deepEqual(row.fence, globalFence);
  assert.equal(row.wait.kind, 'fenced'); assert.equal(row.wait.fenceReason, 'mode_switch');
  assert.ok(row.attention.some(item => item.kind === 'auth_failed' && item.runtime === 'claude'));
  assert.ok(row.attention.find(item => item.kind === 'auth_failed').groups.includes(row.sessionGroup));
});

// Integration: malformed tool input and live-error privacy boundaries. Run when
// observation projection changes; skip rendering-only changes. Owned temporary
// roots, injected sources, no external resources; fixture cleanup.
test('snapshot tolerates non-array tool details and redacts Core read failure text', async t => {
  const f = fixture(t);
  f.live.get('telegram:g0').status.value.active_tool_details = { unexpected: true };
  let snapshot = await f.service.getSnapshot();
  assert.deepEqual(snapshot.rows.find(item => item.sessionGroup === 'telegram:g0').tools, []);
  const reader = f.reader.readSessionState;
  f.reader.readSessionState = key => key === 'telegram:g0'
    ? Promise.reject(new Error('failed Bearer secret123 and sk-123456789012345678901234')) : reader(key);
  f.advance(2100); snapshot = await f.service.getSnapshot();
  const row = snapshot.rows.find(item => item.sessionGroup === 'telegram:g0');
  assert.equal(row.live.error.code, 'READ_FAILED'); assert.match(row.live.error.message, /REDACTED/);
  assert.equal(JSON.stringify(snapshot).includes('secret123'), false);
  assert.equal(JSON.stringify(snapshot).includes('sk-123456789012345678901234'), false);
  assert.equal('buildGroupSnapshot' in f.service, false);
});

// Integration: target configuration uses the same model descriptor for live and
// saved overrides. Run for launch/override projection changes; skip rendering-only
// edits. Temporary root and injected read-only sources; fixture cleanup.
test('live and stopped targets project one model descriptor shape', async t => {
  const f = fixture(t);
  f.live.get('telegram:g0').identity.launchConfig = { runtime: 'claude', mode: 'override', model: 'live-model', effort: 'high' };
  let snapshot = await f.service.getSnapshot();
  assert.deepEqual(snapshot.rows.find(row => row.sessionGroup === 'telegram:g0').target.model, { model: 'live-model', effort: 'high' });
  f.live.delete('telegram:g0'); f.advance(2100);
  snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.rows.find(row => row.sessionGroup === 'telegram:g0').target.model, 'default');
});

// Integration: exact boolean envelope acceptance must fail only its own source.
// Run for Core CLI response changes; skip rendering-only edits. CLI execution is
// injected, never spawns; isolated temporary root and fixture lifecycle cleanup.
for (const [source, ok] of [['c4', 'true'], ['q', 1], ['ov', false]]) {
  test(`imprecise ${source} envelope fails locally without rejecting snapshot`, async t => {
    const f = fixture(t);
    const cli = createCoreCli({ zylosDir: f.root, execute: async (file, argv) => {
      const kind = argv[1] === 'groups' ? 'c4' : argv[1] === 'group-queues' ? 'q' : 'ov';
      const data = kind === 'c4' ? { groups: [], hasOlder: false } : kind === 'q'
        ? { groups: [], globalFence: null } : { baseline: { runtime: 'claude' }, runtime: [], model: [] };
      return { stdout: JSON.stringify({ ok: kind === source ? ok : true, data }) };
    } });
    f.cli.runC4Db = cli.runC4Db; f.cli.readOverrides = cli.readOverrides;
    const value = await f.service.getSnapshot();
    assert.equal(value.sources[source].ok, false);
    assert.equal(value.sources[source].reason, { c4: 'c4_groups_failed', q: 'queue_summary_failed', ov: 'override_list_failed' }[source]);
    for (const other of ['c4', 'q', 'ov'].filter(key => key !== source)) assert.equal(value.sources[other].ok, true);
    assert.equal(value.rows.length, 2);
  });
}

// Integration: C4 read failure must be observable and must not cache a successful
// empty activity response. Run for inbound/error/cache changes; skip rendering-
// only changes. Owned temporary DB/root, no network/children; fixture cleanup.
test('inbound activity missing database and SQL failures expose a source reason', async t => {
  const f = fixture(t), reader = new C4Reader(f.root);
  f.addCleanup(() => reader.close());
  f.c4Reader.getInboundTimes = options => reader.getInboundTimes(options);
  await assert.rejects(f.service.activity('60m'), { code: 'READ_FAILED', reason: 'READ_FAILED', statusCode: 502 });
  fs.mkdirSync(path.join(f.root, 'comm-bridge'));
  const writer = new Database(path.join(f.root, 'comm-bridge', 'c4.db'));
  writer.exec('CREATE TABLE unrelated(id INTEGER)'); writer.close();
  await assert.rejects(f.service.activity('60m'), { code: 'READ_FAILED', reason: 'READ_FAILED', statusCode: 502 });
  reader.close();
  const fixed = new Database(path.join(f.root, 'comm-bridge', 'c4.db'));
  fixed.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY,session_group TEXT,direction TEXT,channel TEXT,timestamp TEXT)'); fixed.close();
  assert.ok((await f.service.activity('60m')).groups['telegram:g0']);
  await assert.rejects(workbenchResponse(f.service, '/api/workbench/activity', new URLSearchParams()), { code: 'invalid_range', statusCode: 400 });
});
