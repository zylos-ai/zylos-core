import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { collectStatus } from '../../../cli/lib/status-view.js';
import { createGroupSnapshot, systemSample, workbenchResponse } from '../src/lib/workbench/group-snapshot.js';
import { createCoreCli } from '../src/lib/workbench/core-cli.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { AuthGate } from '../src/lib/auth.js';
import { Store } from '../src/lib/store.js';
import { chatHttpFixture } from './helpers/chat-http.js';

function fixture(t, { count = 1, statusError = false, modeError = false, overrideError = false,
  c4Error = false, queueError = false, groupListError = false, noSample = false, readPm2 = () => null, readSystem = () => null, groupKeys, displayNames, hotTtlSeconds } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snapshot-'));
  if (hotTtlSeconds !== undefined) {
    fs.mkdirSync(path.join(root, '.zylos'));
    fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ session_hot_ttl_seconds: hotTtlSeconds }));
  }
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); fs.rmSync(root, { recursive: true, force: true }); });
  let clock = 1800000000000, mode = 'multi', unexpected = false, configRuntime = 'codex', configFailure = false, healthRecord = { missing: true };
  const calls = [], observations = [], events = [], reads = [];
  const keys = groupKeys ?? Array.from({ length: count }, (_, index) => `telegram:g${index}`);
  const live = new Map(keys.map(key => [key, { identity: { present: true, ready: true, runtime: 'claude', runId: `run-${key}`,
    createdAt: clock / 1000 - 10, launchConfig: { runtime: 'claude', mode: 'default' } },
    status: { valid: true, sampledAt: clock, value: { state: 'busy', active_tool_details: [{ id: 'T', name: 'Bash', input: { command: 'echo sk-123456789012345678901234' } }] } },
    usage: { valid: false } }]));
  const reader = { readSessionState: async key => {
    observations.push(key);
    return live.get(key) ?? { identity: { present: false }, status: { valid: false, reason: 'not_running' }, usage: { valid: false } };
  }, readAccountUsage: async (runtime, options) => {
    assert.deepEqual(options, { allowRecorded: true });
    reads.push(runtime); if (runtime === 'codex') throw new Error('unreadable');
    return { value: { seven_day: { used_percentage: 23 }, five_hour: { used_percentage: 99 } }, recordedAt: clock - 3600000, live: false };
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
  const service = createGroupSnapshot({ zylosDir: root, store, cli, now: () => clock, readPm2, readSystem, displayNames,
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

// Integration: real snapshot/search plus two private HTTP auth/proxy instances.
// Run for chat access/proxy changes; skip CSS-only changes. Owned temporary root,
// injected Core/CLI, no live DB/PM2/tmux; teardown closes sockets and auth timer.
test('remote chat permission preserves workbench groups and search for all API scopes', async t => {
  const names = new Map([['dashboard:local-chat', { displayName: 'Private project', effectiveName: 'Private project' }]]);
  const f = fixture(t, { groupKeys: ['dashboard:local-chat', 'telegram:external'], displayNames: {
    listAll: () => names, search: term => term === 'Private project' ? [{ sessionGroup: 'dashboard:local-chat' }] : [],
  } });
  const original = f.cli.runC4Db;
  // Core's groups reader supplies the existing 80-character preview.
  const preview = ('Visible summary sk-123456789012345678901234 ' + 'x'.repeat(100)).slice(0, 80);
  f.cli.runC4Db = async args => {
    const value = await original(args);
    if (args[0] !== 'groups') return value;
    const groups = value.data.groups.map(row => ({ ...row, componentName: row.sessionGroup.split(':')[0],
      sessionGroupName: row.sessionGroup.split(':').slice(1).join(':'), preview: { ...row.preview, text: preview } }));
    return args.includes('--key-match') ? { ...value, data: groups } : { ...value, data: { ...value.data, groups } };
  };
  const http = await chatHttpFixture(t, {}, { workbench: url => workbenchResponse(f.service, url.pathname, url.searchParams) });
  for (const allowRemote of [false, true]) {
    http.config.chat.allowRemote = allowRemote;
    for (const identity of ['read', 'admin']) for (const fleet of [false, true]) {
      const direct = await http.request({ method: 'GET', path: '/api/workbench/groups' }, { identity, fleet });
      assert.equal(direct.status, 200);
      const value = JSON.parse(direct.text);
      for (const key of ['dashboard:local-chat', 'telegram:external']) {
        const row = value.rows.find(row => row.sessionGroup === key);
        assert.ok(row.state); assert.ok(Object.hasOwn(row, 'duration'));
        assert.match(row.preview.text, /Visible summary/);
        assert.match(row.preview.text, /REDACTED/);
        assert.ok(row.preview.text.length > 0 && row.preview.text.length <= 80);
        assert.doesNotMatch(row.preview.text, /sk-123456/);
      }
      const search = await http.request({ method: 'GET', path: '/api/workbench/groups/search?q=local-chat' }, { identity, fleet });
      assert.equal(search.status, 200);
      assert.ok(JSON.parse(search.text).rows.some(row => row.sessionGroup === 'dashboard:local-chat'));
      assert.deepEqual(JSON.parse(search.text).rows.find(row => row.sessionGroup === 'dashboard:local-chat').preview,
        value.rows.find(row => row.sessionGroup === 'dashboard:local-chat').preview);
      const named = await http.request({ method: 'GET', path: '/api/workbench/groups/search?q=Private%20project' }, { identity, fleet });
      assert.equal(named.status, 200);
      assert.ok(JSON.parse(named.text).rows.some(row => row.sessionGroup === 'dashboard:local-chat'));
      const activity = await http.request({ method: 'GET', path: '/api/workbench/activity?range=60m' }, { identity, fleet });
      assert.equal(activity.status, 200);
      assert.deepEqual(JSON.parse(activity.text), await f.service.activity('60m'));
    }
  }
});

// Integration: Cross-module snapshot/cache boundary; run for collection or cache changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('snapshot shares in-flight collection, caches from completion, and captures each live observation once', async t => {
  const f = fixture(t), initial = f.cli.runC4Db;
  assert.equal(f.service.getCachedSnapshot(), null);
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
  f.advance(1100);
  assert.equal(f.service.getCachedSnapshot(), results[0], 'cached-only reads do not rebuild an expired snapshot');
  assert.equal(f.calls.length, 3);
  await f.service.getSnapshot(); assert.equal(f.calls.length, 6);
  assert.equal(f.reads.length, 2, 'weekly account cache survives snapshot expiry');
  f.advance(30000); await f.service.getSnapshot(); assert.equal(f.reads.length, 4);
});

// Integration: real snapshot/collectStatus cache bypass after lifecycle changes.
// Run for lifecycle freshness or cache changes; skip UI-only changes. Official
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture owns its root.
// No database, socket, child process, PM2 or network is used.
test('fresh snapshots bypass a completed cache after a session changes', async t => {
  const f = fixture(t);
  assert.ok(f.root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Fresh snapshot isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, root: f.root,
    database: 'none', tmux: 'none', network: 'none', Core: 'injected' }));
  const original = await f.service.getSnapshot();
  f.live.get('telegram:g0').identity.runId = 'replacement-run';
  assert.equal(await f.service.getSnapshot(), original, 'ordinary reads still use the two-second cache');
  const refreshed = await f.service.getSnapshot(f.now(), { fresh: true });
  assert.equal(refreshed.rows.find(row => row.sessionGroup === 'telegram:g0').live.runId, 'replacement-run');
  assert.equal(original.rows.find(row => row.sessionGroup === 'telegram:g0').live.runId, 'run-telegram:g0');
  assert.equal(f.calls.length, 6, 'one additional three-command build');
});

// Integration: real snapshot/collectStatus sequencing with injected Core/CLI;
// run for lifecycle freshness or inflight/cache changes, skip UI-only changes.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture owns
// its temporary root. No database, socket, child process, PM2 or network is used.
test('fresh snapshots wait for an earlier read then observe the next session', { timeout: 1000 }, async t => {
  const f = fixture(t), originalCli = f.cli.runC4Db;
  assert.ok(f.root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Pending snapshot isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, root: f.root,
    database: 'none', tmux: 'none', network: 'none', Core: 'injected' }));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let pendingCalls = 0;
  f.cli.runC4Db = async args => { if (++pendingCalls <= 2) await held; return originalCli(args); };
  const earlier = f.service.getSnapshot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.observations.length, 2, 'the earlier build captured live identities before waiting');
  f.live.get('telegram:g0').identity.runId = 'replacement-run';
  const fresh = f.service.getSnapshot(f.now(), { fresh: true });
  release();
  const [before, after] = await Promise.all([earlier, fresh]);
  assert.equal(before.rows.find(row => row.sessionGroup === 'telegram:g0').live.runId, 'run-telegram:g0');
  assert.equal(after.rows.find(row => row.sessionGroup === 'telegram:g0').live.runId, 'replacement-run');
  assert.equal(f.calls.length, 6);
  assert.equal(await f.service.getSnapshot(), after, 'ordinary readers share the newly completed cache');
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
  const f = fixture(t);
  assert.ok(f.root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Quota snapshot isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: f.root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: path.join(f.root, 'tmux.sock'),
    storage: 'injected, no DB/PM2/tmux/network opened' }));
  const value = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams());
  assert.equal(value.listKnown, true); assert.equal(value.baselineRuntime, 'claude');
  assert.equal(value.instance.pool.used, null); assert.equal(value.instance.pool.capacity, null);
  assert.equal(value.instance.pool.reason, 'pool_occupancy_unreadable');
  assert.equal(value.instance.accounts.claude.used_percentage, 23); assert.equal(value.instance.accounts.codex, null);
  assert.equal(value.instance.accounts.claude.live, false);
  assert.equal(value.instance.accounts.claude.recordedAt, f.now() - 3600000);
  assert.equal(JSON.stringify(value).includes('five_hour'), false);
  assert.equal(value.sources.accounts.codex.reason, 'account_usage_unreadable');
  const row = value.rows.find(item => item.sessionGroup === 'telegram:g0');
  assert.deepEqual(Object.keys(row.c4).sort(), ['componentName', 'lastActivityAt', 'sessionGroupName']);
  assert.equal(row.contextReason, 'usage_unreadable'); assert.equal(row.contextPct, null);
  assert.equal(JSON.stringify(value).includes('sk-123456789012345678901234'), false);
  assert.match(row.preview.text, /REDACTED/); assert.match(row.tools[0].detail, /REDACTED/);
  const summary = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams('view=summary'));
  assert.deepEqual(Object.keys(summary).sort(), ['counts', 'hasOlder', 'mode', 'pool', 'readAt', 'view']);
  assert.deepEqual(summary.pool, { used: null, capacity: null });
});

// Integration: shared PM2 snapshot projection and attention boundary. Run for
// service counts or attention sampling changes; skip UI-only edits. The fixture
// owns its temporary root; PM2, Core and CLI inputs are injected, no children,
// network, live databases or tmux. Fixture teardown removes the owned root.
test('service totals and channel attention share exactly one PM2 sample per snapshot', async t => {
  let reads = 0;
  const sample = { processes: [
    { name: 'zylos-telegram', pm2_env: { status: 'stopped' } },
    { name: 'zylos-dashboard', pm2_env: { status: 'online' } },
    { name: 'zylos-other', pm2_env: { status: 'launching' } },
  ] };
  const f = fixture(t, { readPm2: () => { reads++; return sample; } });
  f.service.channelDownCounter.update(sample);
  f.service.channelDownCounter.update(sample);
  const snapshot = await f.service.getSnapshot();
  assert.equal(reads, 1);
  assert.deepEqual(snapshot.instance.services, { online: 1, total: 3 });
  assert.equal(snapshot.attention.problems.find(item => item.kind === 'channel_down' && item.service === 'zylos-telegram').pm2Status, 'stopped');
  const summary = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams('view=summary'));
  assert.equal(reads, 1, 'summary uses the existing snapshot cache');
  assert.equal(Object.hasOwn(summary, 'services'), false);
  assert.equal(Object.hasOwn(summary, 'instance'), false);
  sample.processes[0].pm2_env.status = 'online';
  f.advance(2100);
  const next = await f.service.getSnapshot();
  assert.equal(reads, 2);
  assert.deepEqual(next.instance.services, { online: 2, total: 3 });
  assert.equal(next.attention.problems.find(item => item.kind === 'channel_down' && item.service === 'zylos-telegram').pm2Status, 'online');
});

// Integration: unknown PM2 samples cannot fabricate counts or break attention.
// Same private fixture boundary as the service-total case; no PM2 process runs.
test('unreadable and malformed PM2 samples keep service counts unknown', async t => {
  for (const sample of [null, {}, { processes: null }, { processes: {} }, { processes: [null] }, 'unreadable']) {
    let calls = 0;
    const f = fixture(t, { readPm2: () => { calls++; if (sample === 'unreadable') throw new Error('read failed'); return sample; } });
    const down = { processes: [{ name: 'zylos-telegram', pm2_env: { status: 'stopped' } }] };
    f.service.channelDownCounter.update(down); f.service.channelDownCounter.update(down);
    const snapshot = await f.service.getSnapshot();
    assert.equal(calls, 1);
    assert.equal(snapshot.instance.services, null);
    assert.equal(snapshot.attention.problems.find(item => item.kind === 'channel_down').pm2Status, null);
  }
  const empty = fixture(t, { readPm2: () => ({ processes: [] }) });
  assert.deepEqual((await empty.service.getSnapshot()).instance.services, { online: 0, total: 0 });
});

// Integration: the snapshot forwards the injected host sample reader. Run for overview snapshot or system sample
// changes; skip rendering-only edits. Same private fixture boundary as the PM2 cases; no collector or PM2 runs.
test('the instance carries the host sample read for this snapshot and stays unknown when unreadable', async t => {
  const sample = { collectedAt: 1799999990000, cpu_pct: 37.5, cpu_count: 8, mem_used_bytes: 2048, mem_total_bytes: 8192,
    disk_used_pct: 61, disk_free_bytes: 4096 };
  let reads = 0;
  const f = fixture(t, { readSystem: () => { reads++; return sample; } });
  const snapshot = await f.service.getSnapshot();
  assert.equal(reads, 1);
  assert.deepEqual(snapshot.instance.system, systemSample(sample));
  assert.deepEqual(snapshot.instance.system, { sampledAt: 1799999990000, cpuPct: 37.5, cpuCount: 8, memUsedBytes: 2048,
    memTotalBytes: 8192, diskUsedPct: 61, diskFreeBytes: 4096 });
  const summary = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams('view=summary'));
  assert.equal(Object.hasOwn(summary, 'instance'), false, 'the summary view stays without host details');
  for (const read of [() => { throw new Error('read failed'); }, () => null]) {
    const unknown = fixture(t, { readSystem: read });
    assert.equal((await unknown.service.getSnapshot()).instance.system, null);
  }
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
  const service = { getSnapshot: async () => ({ rows: [] }), search: async () => ({ rows: [] }), raw: async () => ({ raw: null }) };
  for (const pathname of ['/api/workbench/groups', '/api/workbench/groups/search', '/api/workbench/groups/telegram%3Ag0/raw']) {
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
    if (!filter.sessionGroup || filter.runId || filter.types) return normal(filter);
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

// Integration: a running group whose launch configuration cannot be read carries an
// unknown model with a reason instead of the default. Run for launch/override
// projection changes; skip rendering-only edits. Temporary root and injected
// read-only sources; fixture cleanup.
test('running group without a readable launch configuration reports an unknown model', async t => {
  const f = fixture(t, { count: 4 });
  f.live.get('telegram:g0').identity.launchConfig = null;
  f.live.get('telegram:g1').identity.launchConfig = null; f.live.get('telegram:g1').identity.runtime = 'unknown';
  f.live.delete('telegram:g2');
  const rows = new Map((await f.service.getSnapshot()).rows.map(row => [row.sessionGroup, row]));
  assert.deepEqual(rows.get('telegram:g0').target, { runtime: 'claude', model: null, reason: 'launch_config_unreadable' });
  assert.deepEqual(rows.get('telegram:g1').target, { runtime: 'unknown', model: null, reason: 'launch_config_unreadable' });
  assert.equal(rows.get('telegram:g0').desired.mode, 'default');
  assert.deepEqual(rows.get('telegram:g3').target, { runtime: 'claude', model: 'default' });
  assert.equal(rows.get('telegram:g2').presence, 'not_running');
  assert.deepEqual(rows.get('telegram:g2').target, { runtime: 'claude', model: 'default' });
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

// Integration: C4 read failure preserves Dashboard cells, marks only inbound
// unavailable and is not cached. Run for inbound/error/cache changes; skip rendering-
// only changes. Owned temporary DB/root, no network/children; fixture cleanup.
test('inbound read failures preserve cells, expose a source reason and remain uncached', async t => {
  const f = fixture(t), reader = new C4Reader(f.root);
  f.store.queryEvents = filter => filter.sessionGroup === 'telegram:g0' ? [{
    session_group: 'telegram:g0', run_id: 'run-telegram:g0', event_type: 'user_prompt_submit',
    timestamp: new Date(f.now() - 1000).toISOString(), metadata: {},
  }] : [];
  f.addCleanup(() => reader.close());
  f.c4Reader.getInboundTimes = options => reader.getInboundTimes(options);
  const activity = await f.service.activity('60m');
  assert.equal(activity.inboundError, 'inbound_unreadable');
  assert.equal(activity.groups['telegram:g0'].cells.length, 60);
  assert.equal(activity.groups['telegram:g0'].cells.includes('busy'), true);
  assert.equal(Object.values(activity.groups).every(group => group.inbound.length === 0), true);
  assert.deepEqual(activity.groups['telegram:g0'].inbound, []);
  fs.mkdirSync(path.join(f.root, 'comm-bridge'));
  const writer = new Database(path.join(f.root, 'comm-bridge', 'c4.db'));
  writer.exec('CREATE TABLE unrelated(id INTEGER)'); writer.close();
  assert.equal((await f.service.activity('60m')).inboundError, 'inbound_unreadable');
  reader.close();
  const fixed = new Database(path.join(f.root, 'comm-bridge', 'c4.db'));
  fixed.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY,session_group TEXT,direction TEXT,channel TEXT,timestamp TEXT)'); fixed.close();
  const recovered = await f.service.activity('60m');
  assert.ok(recovered.groups['telegram:g0']);
  assert.equal(Object.hasOwn(recovered, 'inboundError'), false);
  await assert.rejects(workbenchResponse(f.service, '/api/workbench/activity', new URLSearchParams()), { code: 'invalid_range', statusCode: 400 });
});

// Integration: real Store queries plus snapshot-to-bucket projection. Run for
// activity lookback/display changes; skip rendering-only changes. Owned temporary
// SQLite/root, injected Core/CLI; no network, tmux, PM2 or children. Fixture closes
// the DB before removing its root.
for (const [type, metadata, closes] of [
  ['user_prompt_submit', {}, false], ['pre_tool_use', { tool_use_id: 'long' }, false],
  ['subagent_start', { agent_id: 'child' }, false], ['pre_tool_use', { tool_use_id: 'long' }, true],
  ['user_prompt_submit', {}, true],
]) test(`activity recovers pre-window ${type} with closed=${closes} from capped lookups`, async t => {
  const f = fixture(t, { hotTtlSeconds: 7 * 86400 }), store = new Store(path.join(f.root, 'dashboard.db'));
  f.addCleanup(() => store.close());
  const minute = 60000, start = Math.floor(f.now() / minute) * minute - 59 * minute;
  const runStart = start - 20 * minute, filters = [];
  f.live.get('telegram:g0').identity.createdAt = runStart / 1000;
  f.live.get('telegram:g0').status.value.active_tool_details = [];
  const add = (id, event_type, at, run_id, metadata = {}) => store.insertEvent({ id, ingest_id: id,
    timestamp: new Date(at).toISOString(), runtime: 'claude', session_group: 'telegram:g0', run_id,
    event_type, category: 'activity', metadata });
  // A long unrelated history must never be returned by lookback queries.
  store.db.transaction(() => {
    for (let i = 0; i < 2500; i++) add(`old-${i}`, 'user_prompt_submit', runStart - (2501 - i) * minute, `old-run-${i}`);
    add('run-start', 'session_start', runStart, 'run-telegram:g0');
    add('open', type, runStart + minute, 'run-telegram:g0', metadata);
    if (closes) add('close', type === 'pre_tool_use' ? 'post_tool_use' : 'stop',
      type === 'pre_tool_use' ? start + 10 * minute : start - minute, 'run-telegram:g0', metadata);
  })();
  let lookedBack = 0;
  f.store.queryEvents = filter => {
    const rows = store.queryEvents(filter);
    if (filter.until && Date.parse(filter.until) < start) {
      filters.push(filter);
      assert.equal(filter.runId, 'run-telegram:g0');
      assert.equal(filter.sessionGroup, 'telegram:g0');
      assert.ok(rows.length <= filter.limit);
      assert.equal(filter.order, 'desc');
      assert.equal(filter.offset, undefined);
      assert.equal(filter.since, undefined);
      assert.ok([1, 200].includes(filter.limit));
      lookedBack += rows.length;
    }
    return rows;
  };
  const output = await f.service.activity('60m'), cells = output.groups['telegram:g0'].cells;
  assert.equal(filters.length, 6);
  assert.ok(lookedBack <= 603);
  if (!closes) assert.ok(cells.every(value => value === 'busy'));
  else if (type === 'pre_tool_use') {
    assert.ok(cells.slice(0, 10).every(value => value === 'busy'));
    assert.ok(cells.slice(10).every(value => value === 'idle'));
  } else assert.ok(cells.every(value => value === 'idle'));
  assert.ok(output.groups.origin.cells.every(value => value === 'none'));
});

function activityStore(t) {
  // Keep ordering/window tests independent of expiry; freshness cases below use the normal TTL.
  const f = fixture(t, { hotTtlSeconds: 7 * 86400 }), store = new Store(path.join(f.root, 'activity.db'));
  f.addCleanup(() => store.close());
  const minute = 60000, start = Math.floor(f.now() / minute) * minute - 59 * minute;
  const runId = 'run-telegram:g0', filters = [];
  f.live.get('telegram:g0').identity.createdAt = (start - 3 * 86400000) / 1000;
  f.live.get('telegram:g0').status.value.active_tool_details = [];
  const add = (id, event_type, at, metadata = {}, run_id = runId) => store.insertEvent({ id, ingest_id: id,
    timestamp: new Date(at).toISOString(), runtime: 'claude', session_group: 'telegram:g0', run_id,
    event_type, category: 'activity', metadata });
  f.store.queryEvents = filter => {
    const rows = store.queryEvents(filter);
    if (filter.until && Date.parse(filter.until) < start) {
      filters.push({ ...filter, returned: rows.length });
      assert.equal(filter.order, 'desc');
      assert.equal(filter.offset, undefined);
      assert.ok(rows.length <= filter.limit);
    }
    return rows;
  };
  return { f, store, minute, start, runId, filters, add };
}

// Integration: real Store ordering, bounded lookback and bucket projection.
// Run for activity history changes; skip rendering-only edits. Owned temporary
// SQLite/root, injected Core/CLI; no network/tmux/PM2/children; fixture closes DB.
for (const type of ['user_prompt_submit', 'subagent_start']) {
  test(`an old open ${type} survives many completed tools before the window`, async t => {
    const { f, store, minute, start, filters, add } = activityStore(t);
    store.db.transaction(() => {
      add('open', type, start - 3 * 86400000, type === 'subagent_start' ? { agent_id: 'long-child' } : {});
      // Longer than the tool cap; the older open turn/agent must be found by
      // its own event types, rather than by returning all events in the run.
      for (let i = 0; i < 1500; i++) {
        const at = start - 2 * 86400000 + i * minute;
        add(`tool-${i}`, 'pre_tool_use', at, { tool_use_id: `T${i}` });
        add(`end-${i}`, 'post_tool_use', at + 1000, { tool_use_id: `T${i}` });
      }
    })();
    const output = await f.service.activity('60m');
    assert.ok(output.groups['telegram:g0'].cells.every(value => value === 'busy'));
    assert.equal(filters.length, 6);
    assert.ok(filters.reduce((total, filter) => total + filter.returned, 0) <= 603);
    if (type === 'subagent_start') assert.equal(filters.find(filter => filter.types?.includes('pre_tool_use') && filter.agentScope === 'main').returned, 200);
    const queries = filters.length;
    assert.equal(await f.service.activity('60m'), output);
    assert.equal(filters.length, queries);
  });
}

// Integration: replaced-run lookback; same isolated Store fixture boundary.
test('a replaced run opened before the window stays busy until its in-window stop', async t => {
  const { f, minute, start, filters, add } = activityStore(t);
  f.live.get('telegram:g0').identity.createdAt = (start + 40 * minute) / 1000;
  add('old-open', 'user_prompt_submit', start - 10 * minute, {}, 'replaced');
  add('old-stop', 'stop', start + 30 * minute, {}, 'replaced');
  const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
  assert.ok(cells.slice(0, 30).every(value => value === 'busy'));
  assert.ok(cells.slice(30, 40).every(value => value === 'none'));
  assert.ok(cells.slice(40).every(value => value === 'idle'));
  assert.equal(filters.filter(filter => filter.runId === 'replaced').length, 6);
});

// Integration: ingestion order differs from source time; same isolated fixture.
for (const type of ['user_prompt_submit', 'pre_tool_use', 'subagent_start']) {
  test(`late ingestion of an older ${type} does not lose the window baseline`, async t => {
    const { f, minute, start, add } = activityStore(t);
    add('first-ingested', 'session_start', start - minute);
    add('late-open', type, start - 3 * 86400000, type === 'subagent_start' ? { agent_id: 'child' } : { tool_use_id: 'long' });
    const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
    assert.ok(cells.every(value => value === 'busy'));
  });
}

// Integration: cross-type source time and insertion-order ties; same isolated
// Store fixture. Run for turn lookback changes; skip rendering-only edits.
for (const [lateType, equalTime, busy] of [
  ['user_prompt_submit', false, false], ['stop', false, true],
  ['user_prompt_submit', true, true], ['stop', true, false],
]) test(`pre-window late ${lateType} with equalTime=${equalTime} follows source-time turn ordering`, async t => {
  const { f, minute, start, filters, add } = activityStore(t);
  const earlier = start - (equalTime ? 10 : 20) * minute;
  const later = start - 10 * minute;
  add('first', lateType === 'stop' ? 'user_prompt_submit' : 'stop', later);
  add('late', lateType, earlier);
  const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
  assert.ok(cells.every(value => value === (busy ? 'busy' : 'idle')));
  for (const type of ['user_prompt_submit', 'stop']) {
    const query = filters.find(filter => filter.types?.includes(type) && filter.agentScope === 'main' && filter.limit === 1);
    assert.equal(query.limit, 1);
    assert.equal(query.returned, 1);
  }
  assert.equal(filters.length, 6);
});

// Integration: stop fallback closes unmatched tools but not agents; same fixture.
test('pre-window stop closes tools while a child remains busy until its own end', async t => {
  const { f, minute, start, filters, add } = activityStore(t);
  add('tool', 'pre_tool_use', start - 20 * minute, { tool_use_id: 'abandoned' });
  add('child', 'subagent_start', start - 19 * minute, { agent_id: 'child' });
  const stop = add('stop', 'stop', start - 10 * minute);
  add('child-end', 'subagent_stop', start + 10 * minute, { agent_id: 'child' });
  const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
  assert.ok(cells.slice(0, 10).every(value => value === 'busy'));
  assert.ok(cells.slice(10).every(value => value === 'idle'));
  const tools = filters.find(filter => filter.types?.includes('pre_tool_use') && filter.agentScope === 'main');
  assert.equal(tools.afterSeq, undefined, 'Source-time ordering includes pre-stop tools without ingestion cutoffs');
  assert.equal(tools.returned, 1);
});

// Integration: explicit display truncation and unmatched-end behavior; same fixture.
for (const [open, close, idKey] of [['pre_tool_use', 'post_tool_failure', 'tool_use_id'],
  ['subagent_start', 'subagent_stop', 'agent_id']]) {
  test(`pre-window ${open} history is capped without turning unmatched ends busy`, async t => {
    const { f, store, start, filters, add } = activityStore(t);
    store.db.transaction(() => {
      add('old-open', open, start - 10000, { [idKey]: 'outstanding' });
      for (let i = 0; i < 101; i++) {
        add(`start-${i}`, open, start - 9000 + i * 10, { [idKey]: `closed-${i}` });
        add(`end-${i}`, close, start - 8999 + i * 10, { [idKey]: `closed-${i}` });
      }
      add('last-end', close, start - 1000, { [idKey]: 'unmatched' });
    })();
    const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
    assert.ok(cells.every(value => value === 'idle'));
    assert.equal(filters.length, 6);
    assert.equal(filters.find(filter => filter.types?.includes(open) && filter.agentScope === (open === 'subagent_start' ? 'child' : 'main')).returned, 200);
  });
}

// Integration: no-event current/inactive projection. Run for activity baseline
// changes; skip rendering-only changes. Injected adapters, owned temporary root,
// no external resources or children; fixture owns cleanup.
test('activity with no events paints the current run idle from its actual start', async t => {
  const f = fixture(t), start = f.now() - 10 * 60000;
  f.live.get('telegram:g0').status.value.active_tool_details = [];
  f.live.get('telegram:g0').identity.createdAt = start / 1000;
  const output = await f.service.activity('60m'), cells = output.groups['telegram:g0'].cells;
  const index = Math.floor((start - output.start) / 60000);
  assert.ok(cells.slice(0, index).every(value => value === 'none'));
  assert.ok(cells.slice(index).every(value => value === 'idle'));
  assert.ok(output.groups.origin.cells.every(value => value === 'none'));
});

// Integration: Origin error privacy in both collectStatus views; run for Origin
// response/merge changes, skip rendering-only edits. Owned roots, injected Core
// readers/CLI, no live resources or children; fixture cleanup is registered.
for (const mode of ['multi', 'single']) test(`Origin read errors are redacted in ${mode} responses`, async t => {
  const f = fixture(t); f.setMode(mode);
  const original = f.reader.readSessionState;
  const secret = 'sk-123456789012345678901234', raw = `Origin read failed ${secret} person@example.com`;
  f.reader.readSessionState = key => (mode === 'single' || key === 'origin') ? Promise.reject(new Error(raw)) : original(key);
  const snapshot = await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams());
  const origin = snapshot.rows.find(row => row.origin);
  assert.equal(origin.live.error.code, 'READ_FAILED');
  assert.match(origin.live.error.message, /REDACTED/); assert.match(origin.live.error.message, /EMAIL/);
  assert.equal(JSON.stringify(snapshot).includes(raw), false);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(JSON.stringify(snapshot).includes('person@example.com'), false);
});

test('group row thresholds follow actual running models and the desired model while sleeping', async t => {
  const f=fixture(t,{groupKeys:['telegram:small','telegram:large','telegram:sleeping']});
  fs.mkdirSync(path.join(f.root,'.zylos'),{recursive:true});
  fs.mkdirSync(path.join(f.root,'.claude'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'.claude/settings.json'),JSON.stringify({model:'haiku'}));
  fs.writeFileSync(path.join(f.root,'.zylos/config.json'),JSON.stringify({model_rotation_thresholds:{claude:{'claude-sonnet-4-6':63,'claude-opus-4-6[1m]':36,'opus[1m]':36}}}));
  f.live.get('telegram:small').usage={valid:true,value:{model:{id:'claude-sonnet-4-6'},context_window:{context_window_size:200000,used_percentage:60}}};
  f.live.get('telegram:large').usage={valid:true,value:{model:{id:'claude-opus-4-6'},context_window:{context_window_size:1000000,used_percentage:38}}};
  f.live.delete('telegram:sleeping');
  const read=f.cli.readOverrides;
  f.cli.readOverrides=async groups=>{const result=await read(groups);result.data.model=[{sessionGroup:'telegram:sleeping',runtime:'claude',model:'opus[1m]'}];return result;};
  const snapshot=await f.service.getSnapshot();
  assert.deepEqual(snapshot.rows.map(row=>[row.sessionGroup,row.rotationThreshold]).sort(),[
    ['origin',70],['telegram:large',36],['telegram:sleeping',36],['telegram:small',63]
  ]);
});

test('running default-model group threshold stays unknown until the first usage sample', async t => {
  const f = fixture(t, { groupKeys: ['telegram:waiting'] });
  fs.mkdirSync(path.join(f.root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.claude/settings.json'), JSON.stringify({ model: 'opus[1m]' }));
  const pending = (await f.service.getSnapshot()).rows.find(row => row.sessionGroup === 'telegram:waiting');
  assert.equal(pending.presence, 'running');
  assert.equal(pending.rotationThreshold, null);
  f.live.get('telegram:waiting').usage = { valid: true, value: { model: { id: 'claude-opus-4-6' },
    context_window: { context_window_size: 1000000, used_percentage: 20 } } };
  f.advance(2001);
  const sampled = (await f.service.getSnapshot()).rows.find(row => row.sessionGroup === 'telegram:waiting');
  assert.equal(sampled.rotationThreshold, 40);
});

test('group threshold discards the previous model override when session identity changes', async t => {
  const f = fixture(t, { groupKeys: ['telegram:changing'] });
  const observation = f.live.get('telegram:changing');
  observation.identity.launchConfig = { runtime: 'claude', mode: 'override', model: 'opus[1m]' };
  const before = (await f.service.getSnapshot()).rows.find(row => row.sessionGroup === 'telegram:changing');
  assert.equal(before.rotationThreshold, 40, 'a valid captured override supplies the first-sample preview');
  observation.status = { valid: false, reason: 'identity_changed' };
  f.advance(2001);
  const changed = (await f.service.getSnapshot()).rows.find(row => row.sessionGroup === 'telegram:changing');
  assert.equal(changed.rotationThreshold, null);
});

test('group thresholds distinguish the default alias from a fixed version override', async t => {
  const f = fixture(t, { groupKeys: ['telegram:alias', 'telegram:fixed'] });
  for (const dir of ['.zylos', '.claude']) fs.mkdirSync(path.join(f.root, dir), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.claude/settings.json'), JSON.stringify({ model: 'opus[1m]' }));
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ model_rotation_thresholds: { claude: { 'opus[1m]': 30 } } }));
  f.live.get('telegram:alias').usage = { valid: true, value: { model: { id: 'claude-opus-5-5' }, context_window: { context_window_size: 1000000 } } };
  const fixed = f.live.get('telegram:fixed');
  fixed.identity.launchConfig = { runtime: 'claude', mode: 'override', model: 'claude-opus-4-6[1m]' };
  fixed.usage = { valid: true, value: { model: { id: 'claude-opus-4-6' }, context_window: { context_window_size: 1000000 } } };
  const rows = (await f.service.getSnapshot()).rows;
  assert.equal(rows.find(row => row.sessionGroup === 'telegram:alias').rotationThreshold, 30);
  assert.equal(rows.find(row => row.sessionGroup === 'telegram:fixed').rotationThreshold, 40);
});

// Injected Core CLI and owned temporary root (fixture); no live DB/PM2/tmux/network. Run for changes to the
// per-group stored-message read or its route; skip rendering-only edits.
test('a group\'s stored message is read on request, for that exact group, redacted', async t => {
  const f = fixture(t), secret = 'sk-' + 'r'.repeat(32), reads = [];
  const stored = (sessionGroup, messageRaw) => ({ sessionGroup, preview: { message: 'x', messageSource: { kind: 'header' }, messageRaw } });
  // Key search puts the exact key first; without one, its single row is a newer group containing the key.
  const groups = { 'telegram:g1': stored('telegram:g1', '[Bot] line one\nuse ' + secret), origin: stored('origin', '[Scheduled Task: t1] check') };
  f.cli.runC4Db = async args => {
    reads.push(args);
    const key = args[args.indexOf('--key-match') + 1];
    return { ok: true, readAt: f.now(), data: [groups[key] ?? stored(key + '0', 'other group')] };
  };
  const value = await workbenchResponse(f.service, '/api/workbench/groups/telegram%3Ag1/raw', new URLSearchParams());
  assert.deepEqual(value, { raw: '[Bot] line one\nuse [REDACTED]' });
  assert.deepEqual(reads, [['groups', '--key-match', 'telegram:g1', '--limit', '1', '--raw', '--json']]);
  assert.deepEqual(await f.service.raw('telegram:g2'), { raw: null }, 'a group not found has no stored message');
  // Scheduled tasks often land in the origin group, whose key is not a channel key.
  assert.deepEqual(await workbenchResponse(f.service, '/api/workbench/groups/origin/raw', new URLSearchParams()), { raw: '[Scheduled Task: t1] check' });
  f.cli.runC4Db = async args => { reads.push(args); return { ok: false, reason: 'c4_groups_failed', readAt: f.now() }; };
  await assert.rejects(f.service.raw('telegram:g1'), { statusCode: 502, code: 'group_raw_failed' });
  const before = reads.length;
  for (const bad of ['%E0%A4%A', '--x', 'a%20b', 'tg%3A']) {
    await assert.rejects(workbenchResponse(f.service, `/api/workbench/groups/${bad}/raw`, new URLSearchParams()), { statusCode: 400, code: 'SESSION_GROUP_INVALID' });
  }
  assert.equal(reads.length, before, 'invalid keys never reach the CLI');
  // The polled snapshot never asks for stored messages.
  const polled = [];
  f.cli.runC4Db = async args => { polled.push(args); return { ok: true, readAt: f.now(), data: args[0] === 'groups' ? { groups: [], hasOlder: false } : { groups: [], globalFence: null } }; };
  f.advance(5000);
  await f.service.getSnapshot();
  assert.ok(polled.length > 0 && polled.every(args => !args.includes('--raw')));
});

// Integration: actual event Store plus snapshot/API and activity projection, on
// owned temporary roots/DBs with injected Core/CLI. Run for working/freshness or
// source-time query changes; skip unrelated rendering. No live resources,
// network, PM2, tmux or children; fixture closes Store before removing its root.
function workingFixture(t, options = {}) {
  const f = fixture(t, options), store = new Store(path.join(f.root, 'working.db'));
  f.addCleanup(() => store.close());
  f.live.get('telegram:g0').status.value.active_tool_details = [];
  const queries = [];
  f.store.queryEvents = filter => { queries.push(filter); return store.queryEvents(filter); };
  const run = 'run-telegram:g0';
  const add = (type, ago, metadata = {}, runId = run) => {
    const id = crypto.randomUUID();
    return store.insertEvent({ id, ingest_id: id, timestamp: new Date(f.now() - ago).toISOString(),
      runtime: 'claude', session_group: 'telegram:g0', run_id: runId, event_type: type, category: 'activity', metadata });
  };
  const read = async () => {
    const row = (await workbenchResponse(f.service, '/api/workbench/groups', new URLSearchParams())).rows
      .find(row => row.sessionGroup === 'telegram:g0');
    assert.ok(Object.hasOwn(row, 'working'), 'Groups API publishes the working field');
    return row;
  };
  return { f, store, add, read, queries };
}

for (const kind of ['main', 'children', 'stale child']) test(`working API projects ${kind} events without changing Core board state`, async t => {
  const { f, add, read } = workingFixture(t), minute = 60000;
  const at = f.now();
  add('user_prompt_submit', 5 * minute);
  if (kind !== 'main') {
    add('stop', 4 * minute);
    add('subagent_start', kind === 'children' ? 3 * minute : 31 * minute, { agent_id: 'one' });
    if (kind === 'children') add('subagent_start', 2 * minute, { agent_id: 'two' });
  }
  const row = await read();
  assert.equal(row.state.kind, 'busy', 'Core state remains unchanged even when display work is idle');
  if (kind === 'main') assert.deepEqual(row.working, { on: true, since: at - 5 * minute,
    turn: { since: at - 5 * minute }, tools: 0, subagents: null });
  else if (kind === 'children') assert.deepEqual(row.working, { on: true, since: at - 3 * minute,
    turn: null, tools: 0, subagents: { count: 2, since: at - 3 * minute, lastActivityAt: at - 2 * minute } });
  else assert.deepEqual(row.working, { on: false, since: null, turn: null, tools: 0, subagents: null });
});

for (const endType of ['stop', 'turn_complete', 'dashboard_interrupt', 'runtime_health:stop_failure']) test(`working uses source-time ${endType} and insertion-order ties without child shadowing`, async t => {
  const { f, add, read } = workingFixture(t);
  add('user_prompt_submit', 6000);
  add(endType, 9000); // Ingested later, but older than the prompt.
  add(endType, 1000, { agent_id: 'child' });
  assert.equal((await read()).working.turn.since, f.now() - 6000);
  add(endType, 6000); f.advance(2100);
  assert.equal((await read()).working.on, false, 'Same-time later insertion closes the main turn');
  add('user_prompt_submit', 8100); f.advance(2100);
  assert.equal((await read()).working.on, true, 'Same-time later prompt opens the main turn');
});

for (const condition of ['not running', 'no run', 'status failed']) test(`working is null when ${condition}`, async t => {
  const { f, add, read } = workingFixture(t, { statusError: condition === 'status failed' });
  add('user_prompt_submit', 1000);
  if (condition === 'not running') f.live.get('telegram:g0').identity.present = false;
  if (condition === 'no run') f.live.get('telegram:g0').identity.runId = null;
  assert.equal((await read()).working, null);
});

test('working main freshness includes any event while tools alone have no invented time anchor', async t => {
  const { f, add, read } = workingFixture(t), minute = 60000;
  add('user_prompt_submit', 31 * minute);
  assert.equal((await read()).working.on, false);
  add('assistant_message', 1000); f.advance(2100);
  assert.equal((await read()).working.turn.since, f.now() - 2100 - 31 * minute);
  add('stop', 0); f.live.get('telegram:g0').status.value.active_tool_details = [{ id: 'live', name: 'Bash', input: {} }]; f.advance(2100);
  assert.deepEqual((await read()).working, { on: true, since: null, turn: null, tools: 1, subagents: null });
});

test('working child freshness uses its own tools and the Core configured TTL', async t => {
  const { f, add, read } = workingFixture(t), minute = 60000;
  fs.mkdirSync(path.join(f.root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ session_hot_ttl_seconds: 60 }));
  add('subagent_start', 2 * minute, { agent_id: 'child' });
  add('pre_tool_use', 30000, { agent_id: 'child', tool_use_id: 'child-tool' });
  add('assistant_message', 1000, { agent_id: 'other' });
  const live = (await read()).working;
  assert.equal(live.subagents.count, 1); assert.equal(live.subagents.lastActivityAt, f.now() - 30000);
  f.advance(31000);
  assert.equal((await read()).working.on, false, 'Other agents and a lost child-tool end do not keep this child alive');
});

test('working uses environment TTL precedence and reads source-time facts with bounded child lookback', async t => {
  const { f, add, read, queries } = workingFixture(t);
  const prior = process.env.ZYLOS_SESSION_HOT_TTL_SECONDS;
  process.env.ZYLOS_SESSION_HOT_TTL_SECONDS = '45';
  t.after(() => { if (prior === undefined) delete process.env.ZYLOS_SESSION_HOT_TTL_SECONDS; else process.env.ZYLOS_SESSION_HOT_TTL_SECONDS = prior; });
  fs.mkdirSync(path.join(f.root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ session_hot_ttl_seconds: 300 }));
  add('user_prompt_submit', 50000); add('subagent_start', 50000, { agent_id: 'child' });
  const row = await read();
  assert.equal(row.working.on, false);
  const reads = queries.filter(query => query.runId === 'run-telegram:g0' && query.sourceTime);
  assert.equal(reads.length, 5);
  assert.equal(reads.filter(query => query.limit === 200 && query.agentScope === 'child').length, 2);
  assert.equal(reads.find(query => query.types?.includes('pre_tool_use')).latestPerAgent, true);
  assert.ok(reads.every(query => query.order === 'desc' && [1, 200].includes(query.limit)));
});

test('source-time event ordering preserves default sequence order and handles offsets ties and child scopes', async t => {
  const { f, store } = workingFixture(t);
  const rows = [
    ['first', '2027-01-01T00:00:05Z', {}],
    ['late-old', '2027-01-01T01:00:00+01:00', {}],
    ['equal', '2027-01-01T00:00:05.000Z', {}],
    ['child', '2027-01-01T00:00:09Z', { agent_id: 'child' }],
  ];
  for (const [id, timestamp, metadata] of rows) store.insertEvent({ id, ingest_id: id, timestamp,
    session_group: 'telegram:g0', run_id: 'run', event_type: 'stop', category: 'activity', metadata });
  const filter = { sessionGroup: 'telegram:g0', runId: 'run', until: '2027-01-01T00:00:10Z', limit: 1, order: 'desc' };
  assert.equal(store.queryEvents(filter)[0].id, 'child');
  assert.equal(store.queryEvents({ ...filter, sourceTime: true, agentScope: 'main' })[0].id, 'equal');
  assert.equal(store.queryEvents({ ...filter, sourceTime: true, agentScope: 'child' })[0].id, 'child');
  assert.equal(store.queryEvents({ ...filter, sourceTime: true, until: '2027-01-01T00:00:01Z' })[0].id, 'late-old');
  assert.equal(store.queryEvents({ ...filter, sourceTime: true, agentScope: 'main', order: 'asc' })[0].id, 'late-old');
  store.db.transaction(() => {
    for (let i = 0; i < 210; i++) store.insertEvent({ id: `bounded-${i}`, ingest_id: `bounded-${i}`, timestamp: new Date(f.now() - i).toISOString(),
      session_group: 'telegram:g0', run_id: 'bounded', event_type: 'subagent_start', category: 'activity', metadata: { agent_id: `child-${i}` } });
  })();
  assert.equal(store.queryEvents({ runId: 'bounded', sourceTime: true, order: 'desc', limit: 200 }).length, 200);
});

for (const kind of ['main', 'child']) test(`working activity seeds ${kind} freshness from before the visible window`, async t => {
  const { f, add } = workingFixture(t), minute = 60000;
  const start = Math.floor(f.now() / minute) * minute - 59 * minute;
  f.live.get('telegram:g0').identity.createdAt = (f.now() - 120 * minute) / 1000;
  if (kind === 'main') {
    add('user_prompt_submit', 90 * minute);
    add('assistant_message', f.now() - (start - minute));
  } else {
    add('subagent_start', 90 * minute, { agent_id: 'child' });
    add('pre_tool_use', f.now() - (start - minute), { agent_id: 'child', tool_use_id: 'still-working' });
  }
  const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
  assert.equal(cells[0], 'busy', 'A recent pre-window event refreshes the old open work');
  assert.equal(cells[29], 'idle', 'The same shared TTL ends the interval without a lost end event');
  assert.equal(cells.at(-1), 'idle');
});

// Same owned Store/snapshot fixture as the working cases above. Source offsets
// must use the same instant for the visible window and its lookback boundary.
test('working activity includes offset timestamps inside its visible window', async t => {
  const { f, store, read } = workingFixture(t);
  const at = Date.parse('2027-01-01T10:05:00.000Z');
  f.setNow(at);
  f.live.get('telegram:g0').identity.createdAt = (at - 15 * 60000) / 1000;
  store.insertEvent({ id: 'offset-prompt', ingest_id: 'offset-prompt', timestamp: '2027-01-01T11:00:00+01:00',
    session_group: 'telegram:g0', run_id: 'run-telegram:g0', runtime: 'claude', event_type: 'user_prompt_submit', category: 'activity' });
  const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
  assert.equal(cells.at(-1), 'busy', 'The in-window prompt cannot fall between lexical window and source-time seed filters');
  assert.equal((await read()).working.on, true);
});

// Real Store, snapshot and activity fixture above; no live resources. Keep
// lifetime transitions visible even when a child emits many tool pairs.
for (const position of ['current', 'before window']) test(`working preserves an active child's start through many tools ${position}`, async t => {
  const { f, store, add, read, queries } = workingFixture(t), minute = 60000;
  const at = f.now(), start = Math.floor(at / minute) * minute - 59 * minute;
  const anchor = position === 'current' ? at : start;
  f.live.get('telegram:g0').identity.createdAt = (anchor - 21 * minute) / 1000;
  store.db.transaction(() => {
    add('subagent_start', at - (anchor - 20 * minute), { agent_id: 'long-child' });
    for (let i = 0; i < 150; i++) {
      const toolAt = anchor - 19 * minute + Math.floor(i * 17.5 * minute / 149);
      add('pre_tool_use', at - toolAt, { agent_id: 'long-child', tool_use_id: `child-tool-${i}` });
      add('post_tool_use', at - toolAt - 500, { agent_id: 'long-child', tool_use_id: `child-tool-${i}` });
    }
  })();
  if (position === 'current') {
    const work = (await read()).working;
    assert.deepEqual(work, { on: true, since: at - 20 * minute, turn: null, tools: 0,
      subagents: { count: 1, since: at - 20 * minute, lastActivityAt: at - 1.5 * minute + 500 } });
  }
  const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
  if (position === 'current') assert.equal(cells.at(-1), 'busy');
  else {
    assert.equal(cells[0], 'busy', 'A pre-window start survives more than 200 child-tool events');
    assert.equal(cells[29], 'idle', 'The child still expires using its most recent own event');
    const seedReads = queries.filter(query => query.runId === 'run-telegram:g0' && query.until && Date.parse(query.until) < start);
    const transitions = seedReads.find(query => query.agentScope === 'child' && query.types.includes('subagent_start'));
    const tools = seedReads.find(query => query.agentScope === 'child' && query.types.includes('pre_tool_use'));
    assert.equal(transitions.limit, 200); assert.equal(tools.limit, 200);
    assert.equal(store.queryEvents(transitions).length, 1);
    assert.equal(tools.latestPerAgent, true);
    assert.equal(store.queryEvents(tools).length, 1);
  }
});

// Real Store/API and activity fixtures: a busy sibling cannot evict another
// child's own freshness, either now or when seeding the visible window.
for (const stopped of [false, true]) test(`working keeps a quiet child when its noisy sibling is ${stopped ? 'stopped' : 'running'}`, async t => {
  const { f, store, add, read } = workingFixture(t), minute = 60000, at = f.now();
  store.db.transaction(() => {
    add('subagent_start', 40 * minute, { agent_id: 'quiet' });
    add('pre_tool_use', 10 * minute, { agent_id: 'quiet', tool_use_id: 'long-command' });
    add('subagent_start', 12 * minute, { agent_id: 'noisy' });
    for (let i = 0; i < 110; i++) {
      const ago = 9 * minute - i * 4000;
      add('pre_tool_use', ago, { agent_id: 'noisy', tool_use_id: `tool-${i}` });
      add('post_tool_use', ago - 500, { agent_id: 'noisy', tool_use_id: `tool-${i}` });
    }
    if (stopped) add('subagent_stop', 30000, { agent_id: 'noisy' });
  })();
  const work = (await read()).working;
  assert.equal(work.on, true);
  assert.equal(work.since, at - 40 * minute);
  assert.equal(work.subagents.count, stopped ? 1 : 2);
  assert.equal(work.subagents.lastActivityAt, stopped ? at - 10 * minute : at - 9 * minute + 109 * 4000 + 500);
});

test('working activity seeds each child freshness independently of a noisy sibling', async t => {
  const { f, store, add } = workingFixture(t), minute = 60000, at = f.now();
  const start = Math.floor(at / minute) * minute - 59 * minute;
  const before = ago => at - start + ago;
  f.live.get('telegram:g0').identity.createdAt = (start - 41 * minute) / 1000;
  store.db.transaction(() => {
    add('subagent_start', before(40 * minute), { agent_id: 'quiet' });
    add('pre_tool_use', before(10 * minute), { agent_id: 'quiet', tool_use_id: 'long-command' });
    add('subagent_start', before(12 * minute), { agent_id: 'noisy' });
    for (let i = 0; i < 110; i++) {
      const ago = before(9 * minute - i * 4000);
      add('pre_tool_use', ago, { agent_id: 'noisy', tool_use_id: `tool-${i}` });
      add('post_tool_use', ago - 500, { agent_id: 'noisy', tool_use_id: `tool-${i}` });
    }
    add('subagent_stop', before(30000), { agent_id: 'noisy' });
  })();
  const cells = (await f.service.activity('60m')).groups['telegram:g0'].cells;
  assert.equal(cells[0], 'busy', 'The quiet child refreshed ten minutes before the window');
  assert.equal(cells[19], 'busy');
  assert.equal(cells[20], 'idle', 'The stopped sibling cannot extend the quiet child beyond its own TTL');
});

test('latest child tool queries preserve per-child source order ties scope and bounded output', t => {
  const { store } = workingFixture(t);
  const put = (id, timestamp, agent, runId = 'tools') => store.insertEvent({ id, ingest_id: id, timestamp,
    session_group: 'telegram:g0', run_id: runId, event_type: 'pre_tool_use', category: 'activity', metadata: { agent_id: agent } });
  put('quiet-new', '2027-01-01T00:00:10Z', 'quiet');
  put('quiet-tie', '2027-01-01T00:00:10Z', 'quiet');
  put('quiet-late-old', '2027-01-01T01:00:09+01:00', 'quiet');
  put('other-run', '2027-01-01T00:00:11Z', 'quiet', 'other');
  put('main', '2027-01-01T00:00:11Z', '');
  store.db.transaction(() => {
    for (let i = 0; i < 210; i++) put(`child-${i}`, '2027-01-01T00:00:08Z', `child-${i}`);
  })();
  const rows = store.queryEvents({ sessionGroup: 'telegram:g0', runId: 'tools', types: ['pre_tool_use'],
    until: '2027-01-01T00:00:12Z', agentScope: 'child', sourceTime: true, order: 'desc', latestPerAgent: true, limit: 200 });
  assert.equal(rows.length, 200);
  assert.equal(rows[0].id, 'quiet-tie', 'Source-time order wins over later ingestion; event_seq resolves ties');
  assert.equal(new Set(rows.map(row => row.metadata.agent_id)).size, 200);
  assert.equal(rows.some(row => ['other-run', 'main', 'quiet-late-old'].includes(row.id)), false);
  assert.equal(Object.hasOwn(rows[0], 'agent_rank'), false, 'Query bookkeeping does not leak into event fields');
});

test('working removes a child when its own stop is stored', async t => {
  const { add, read } = workingFixture(t);
  add('subagent_start', 3 * 60000, { agent_id: 'child' });
  add('subagent_stop', 60000, { agent_id: 'child' });
  assert.deepEqual((await read()).working, { on: false, since: null, turn: null, tools: 0, subagents: null });
});

test('working retains the remaining child and its own start after another child stops', async t => {
  const { f, add, read } = workingFixture(t), at = f.now();
  add('subagent_start', 20 * 60000, { agent_id: 'first' });
  add('subagent_start', 10 * 60000, { agent_id: 'remaining' });
  add('subagent_stop', 60000, { agent_id: 'first' });
  assert.deepEqual((await read()).working, { on: true, since: at - 10 * 60000, turn: null, tools: 0,
    subagents: { count: 1, since: at - 10 * 60000, lastActivityAt: at - 10 * 60000 } });
});

test('working keeps an old open turn and its elapsed anchor while a main tool runs', async t => {
  const { f, add, read } = workingFixture(t), since = f.now() - 45 * 60000;
  add('user_prompt_submit', 45 * 60000);
  f.live.get('telegram:g0').status.value.active_tool_details = [{ id: 'still-running', name: 'Bash', input: {} }];
  assert.deepEqual((await read()).working, { on: true, since, turn: { since }, tools: 1, subagents: null });
});


// Private Store/Core fixtures only: run for working terminal-event queries or
// reduction changes; skip unrelated UI changes. No live runtime/channel starts.
test('working ends a failed main turn even after a newer diagnostic event', async t => {
  const { f, add, read } = workingFixture(t);
  add('user_prompt_submit', 9000);
  add('assistant_message', 6000);
  add('runtime_health:stop_failure', 3000);
  add('runtime_health:recovered', 1000);
  assert.equal((await read()).working.on, false);
  add('user_prompt_submit', 0); f.advance(2100);
  assert.equal((await read()).working.on, true, 'a new prompt opens a fresh turn');
});
