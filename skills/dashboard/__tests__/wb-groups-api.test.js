import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectStatus } from '../../../cli/lib/status-view.js';
import { RestartRequestStore } from '../../activity-monitor/scripts/restart-request-store.js';
import { createGroupSnapshot } from '../src/lib/workbench/group-snapshot.js';
import { createCoreCli } from '../src/lib/workbench/core-cli.js';
import { createGroupsApi, groupKey } from '../src/lib/workbench/groups-api.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});

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
  const calls = [], observations = [], events = [], reads = [], statusReadErrors = new Map();
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
  const sessionObservations = {
    reader,
    async get() {
      const group = mode === 'single' ? null : 'origin';
      const groups = mode === 'single' ? [null] : [...new Set(['origin', ...keys])];
      const values = await Promise.all(groups.map(async key =>
        [key, structuredClone(await reader.readSessionState(key))]));
      return { mode: modeError ? 'unreadable' : mode, group, observations: new Map(values) };
    },
    peek() { return null; },
  };
  const service = createGroupSnapshot({ zylosDir: root, store, cli, now: () => clock, readPm2, readSystem, displayNames, sessionObservations,
    readChannels: () => [{ channel: 'telegram', service: 'zylos-telegram' }],
    c4Reader, readConfigRuntime: () => { if (configFailure) throw new Error('config'); return configRuntime; }, loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => { if (modeError) throw new Error('config'); return { mode }; } };
      if (name === 'session-state-reader.js') return reader;
      return { collectStatus: options => {
        if (statusError) throw new Error('status');
        return collectStatus({ ...options, mode: () => ({ mode }), now: () => clock, resolveRoot: () => root,
          session: async (group, settings) => {
            if (statusReadErrors.has(group)) throw statusReadErrors.get(group);
            return options.session(group, settings);
          },
          requests: () => new RestartRequestStore({ file: path.join(root, 'restart-requests.json') }).read(),
          list: () => { if (groupListError) throw new Error('list'); return keys.map(sessionGroup => ({ sessionGroup })); },
          health: () => healthRecord });
      } };
    } });
  return { service, root, calls, observations, live, reads, events, reader, cli, store, c4Reader,
    addCleanup: close => cleanup.push(close),
    failStatusRead: (group, error) => statusReadErrors.set(group, error),
    setHealth: value => { healthRecord = value; }, setConfigRuntime: value => { configRuntime = value; }, failConfig: value => { configFailure = value; },
    setNow: value => { clock = value; }, advance: value => { clock += value; }, setMode: value => { mode = value; },
    failUnexpected: value => { unexpected = value; }, now: () => clock };
}

// HTTP integration: real config PUT, cached group detail GET, and the shared
// configuration summary. Run for config writes or snapshot refresh wiring.
// Use the runner's isolated HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR, a
// loopback listener and a private dashboard DB. Inject Core replies, so no
// CLI process, PM2 or tmux socket is needed. Skip for unrelated UI changes.

// Collection integration: actual C4 queue/catalog SQL over a private, read-only
// SQLite connection -> actual snapshot and public API projections in both modes.
// Run for queue, preview or group projection changes; skip unrelated UI edits.
// The official runner supplies private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR.
// No processes, timers, network or tmux sockets start; fixture teardown closes
// the DB before removing its root, including on assertion failure.

// Injected queue observations and private runner root; no DB or processes.
// Run for aggregate queue head ordering; lower priority number wins before id.

// Injected channel catalog with no inbound preview, private runner root only.
// Run for single Origin raw-source selection; no DB, processes or sockets.

// Real Core status -> Workbench observations, isolated store and fake
// clock/CLI/scenes. Run for request-pause wiring; skip unrelated UI work. No
// daemon, runtime, database or network; fixture removes its own files.

// Integration: real snapshot/search plus two private HTTP auth/proxy instances.
// Run for chat access/proxy changes; skip CSS-only changes. Owned temporary root,
// injected Core/CLI, no live DB/PM2/tmux; teardown closes sockets and auth timer.

// Integration: Cross-module snapshot/cache boundary; run for collection or cache changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: real snapshot/collectStatus cache bypass after lifecycle changes.
// Run for lifecycle freshness or cache changes; skip UI-only changes. Official
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture owns its root.
// No database, socket, child process, PM2 or network is used.

// Integration: real snapshot/collectStatus sequencing with injected Core/CLI;
// run for lifecycle freshness or inflight/cache changes, skip UI-only changes.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture owns
// its temporary root. No database, socket, child process, PM2 or network is used.

// Integration: Cross-module failure/retry boundary; run for snapshot error handling changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: Cross-module response/privacy boundary; run for snapshot or response changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.
test('full and summary responses preserve metadata-only C4 and redact messages and tools', async t => {
  const f = fixture(t);
  assert.ok(f.root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Quota snapshot isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: f.root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: path.join(f.root, 'tmux.sock'),
    storage: 'injected, no DB/PM2/tmux/network opened' }));
  const value = await f.service.getSnapshot();
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
  const summary = await createGroupsApi({ workbench: f.service }).counts();
  assert.deepEqual(Object.keys(summary).sort(), ['listKnown', 'offline', 'pool', 'readAt', 'running']);
  assert.equal(summary.pool.used, null); assert.equal(summary.pool.capacity, null);
});

// Integration: shared PM2 snapshot projection and attention boundary. Run for
// service counts or attention sampling changes; skip UI-only edits. The fixture
// owns its temporary root; PM2, Core and CLI inputs are injected, no children,
// network, live databases or tmux. Fixture teardown removes the owned root.

// Integration: unknown PM2 samples cannot fabricate counts or break attention.
// Same private fixture boundary as the service-total case; no PM2 process runs.

// Integration: the snapshot forwards the injected host sample reader. Run for overview snapshot or system sample
// changes; skip rendering-only edits. Same private fixture boundary as the PM2 cases; no collector or PM2 runs.

// Integration: Cross-module absent-sample boundary; run for pool projection changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: per-source failure projection; run for snapshot source/error changes;
// skip rendering-only edits. Owned temporary roots, injected adapters, no live
// tmux/PM2/network; fixture cleanup is registered for every table case.

// Integration: Cross-module single-view boundary; run for view or activity query changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Actual event/C4 databases, snapshot and authenticated loopback activity route.
// Both ranges exercise source keys, window seeding and rejection of unrelated
// events/internal/outbound messages. The official runner isolates all paths;
// fixture teardown closes HTTP/auth/SQLite before removing its private root.

test('Core CLI uses bounded argv children, exact envelopes, and the complete runtime override catalog and bounded model batches', async () => {
  const calls = []; let active = 0, peak = 0;
  const cli = createCoreCli({ zylosDir: '/isolated/zylos', env: { PATH: '/fixture', ZYLOS_SESSION_GROUP: 'old' },
    execute: async (file, argv, options) => {
      calls.push({ file, argv, options }); active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--;
      const secondBatch = calls.length === 5;
      return { stdout: JSON.stringify({ ok: true, data: {
        baseline: { runtime: secondBatch ? 'claude' : 'codex' },
        runtime: calls.length === 2 ? [{ sessionGroup: 'tg:g0', runtime: 'claude' }]
          : calls.length === 3 ? [{ sessionGroup: 'tg:unlisted', runtime: 'codex' }] : [],
        nextAfter: calls.length === 2 ? 'tg:g0' : null,
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
  assert.equal(result.ok, true); assert.equal(calls.length, 5); assert.equal(peak, 1);
  const requested = calls.slice(1).flatMap(call => call.argv.filter((value, i, all) => all[i - 1] === '--group'));
  assert.equal(requested.length, 502); assert.equal(new Set(requested).size, 502);
  assert.equal(requested.includes(null), false); assert.equal(calls[4].argv.filter(v => v === '--group').length, 2);
  assert.deepEqual(calls[1].argv, ['group', 'overrides', '--json']);
  assert.deepEqual(calls[2].argv, ['group', 'overrides', '--after', 'tg:g0', '--json']);
  assert.deepEqual(result.data.baseline, { runtime: 'codex' });
  assert.deepEqual(result.data.runtime, [{ sessionGroup: 'tg:g0', runtime: 'claude' }, { sessionGroup: 'tg:unlisted', runtime: 'codex' }]);
  assert.deepEqual(result.data.model, [{ sessionGroup: 'tg:g499', runtime: 'codex', model: 'selected', effort: 'high' }]);
});

// Read-only integration: private SQLite fixture, no tmux/PM2/network. Run for
// activity source filtering or read SQL changes; skip unrelated UI edits. Close
// reader before comparing and removing only owned fixture files.

// Integration: Actual AuthGate plus shared responses; run for API access or dispatch changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: Cross-module bounded collection timing; run for snapshot source call changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: Cross-module live/desired configuration boundary; run for override projection changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: Cross-module failed-source union/baseline boundary; run for source merge changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: Cross-module mode/config fallback boundary; run for configuration projection changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: Cross-module per-reader failure boundary; run for observation handling changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Integration: actual Store with source timestamps arriving out of order. Run for
// duration or event query changes; skip rendering-only edits. Owned fixture DB,
// injected Core/CLI, no live resources; fixture closes Store before cleanup.

// Integration: Cross-module activity pagination/cache boundary; run for activity query/cache changes.
// Skip rendering-only edits. Owned temporary root/DB, injected Core/CLI; no live
// tmux/PM2/network. Fixture cleanup closes owned resources; auth timer is stopped.

// Loopback route and real snapshot activity. Run for activity validation,
// query scoping or caching changes. Owned fixture paths and injected event,
// C4 and Core readers keep this independent of PM2, tmux and live databases.

// Full read-only boundary: actual Dashboard Store and C4Reader on owned SQLite
// fixtures; Core readers/CLI are injected read-only adapters. Run for snapshot or
// activity read wiring; skip unrelated rendering. No tmux/PM2/network/children.
// Connections close before root cleanup; compare bytes instead of row diff dumps.

// Integration: source-envelope and row-enrichment boundaries. Run for Core input,
// privacy or snapshot changes; skip rendering-only changes. Owned temporary roots,
// injected CLI/reader adapters, no live tmux/PM2/network/children; fixture cleanup.

// Integration: malformed tool input and live-error privacy boundaries. Run when
// observation projection changes; skip rendering-only changes. Owned temporary
// roots, injected sources, no external resources; fixture cleanup.

// Integration: target configuration uses the same model descriptor for live and
// saved overrides. Run for launch/override projection changes; skip rendering-only
// edits. Temporary root and injected read-only sources; fixture cleanup.

// Integration: a running group whose launch configuration cannot be read carries an
// unknown model with a reason instead of the default. Run for launch/override
// projection changes; skip rendering-only edits. Temporary root and injected
// read-only sources; fixture cleanup.

// Integration: exact boolean envelope acceptance must fail only its own source.
// Run for Core CLI response changes; skip rendering-only edits. CLI execution is
// injected, never spawns; isolated temporary root and fixture lifecycle cleanup.

// Integration: C4 read failure preserves Dashboard cells, marks only inbound
// unavailable and is not cached. Run for inbound/error/cache changes; skip rendering-
// only changes. Owned temporary DB/root, no network/children; fixture cleanup.

// Integration: real Store queries plus snapshot-to-bucket projection. Run for
// activity lookback/display changes; skip rendering-only changes. Owned temporary
// SQLite/root, injected Core/CLI; no network, tmux, PM2 or children. Fixture closes
// the DB before removing its root.

// Integration: real Store ordering, bounded lookback and bucket projection.
// Run for activity history changes; skip rendering-only edits. Owned temporary
// SQLite/root, injected Core/CLI; no network/tmux/PM2/children; fixture closes DB.

// Integration: replaced-run lookback; same isolated Store fixture boundary.

// Integration: ingestion order differs from source time; same isolated fixture.

// Integration: cross-type source time and insertion-order ties; same isolated
// Store fixture. Run for turn lookback changes; skip rendering-only edits.

// Integration: stop fallback closes unmatched tools but not agents; same fixture.

// Integration: explicit display truncation and unmatched-end behavior; same fixture.

// Integration: no-event current/inactive projection. Run for activity baseline
// changes; skip rendering-only changes. Injected adapters, owned temporary root,
// no external resources or children; fixture owns cleanup.

// Integration: Origin error privacy in both collectStatus views; run for Origin
// response/merge changes, skip rendering-only edits. Owned roots, injected Core
// readers/CLI, no live resources or children; fixture cleanup is registered.

// Injected Core CLI and owned temporary root (fixture); no live DB/PM2/tmux/network. Run for changes to the
// per-group stored-message read or its route; skip rendering-only edits.
test('a group\'s stored message is read on request, for that exact group, redacted', async t => {
  const f = fixture(t), secret = 'sk-' + 'r'.repeat(32), reads = [];
  const snapshot = await f.service.getSnapshot();
  const stored = (sessionGroup, messageRaw) => ({ sessionGroup, preview: { message: 'x', messageSource: { kind: 'header' }, messageRaw } });
  // Key search puts the exact key first; without one, its single row is a newer group containing the key.
  const groups = { 'telegram:g1': stored('telegram:g1', '[Bot] line one\nuse ' + secret), origin: stored('origin', '[Scheduled Task: t1] check') };
  f.cli.runC4Db = async args => {
    reads.push(args);
    const key = args[args.indexOf('--key-match') + 1];
    return { ok: true, readAt: f.now(), data: [groups[key] ?? stored(key + '0', 'other group')] };
  };
  const value = await f.service.raw('telegram:g1', snapshot);
  assert.deepEqual(value, { raw: '[Bot] line one\nuse [REDACTED]' });
  assert.deepEqual(reads, [['groups', '--key-match', 'telegram:g1', '--limit', '1', '--raw', '--json']]);
  assert.deepEqual(await f.service.raw('telegram:g2', snapshot), { raw: null }, 'a group not found has no stored message');
  // Scheduled tasks often land in the origin group, whose key is not a channel key.
  assert.deepEqual(await f.service.raw('origin', snapshot), { raw: '[Scheduled Task: t1] check' });
  f.cli.runC4Db = async args => { reads.push(args); return { ok: false, reason: 'c4_groups_failed', readAt: f.now() }; };
  await assert.rejects(f.service.raw('telegram:g1', snapshot), { statusCode: 502, code: 'group_raw_failed' });
  const before = reads.length;
  for (const bad of ['%E0%A4%A', '--x', 'a%20b', 'tg%3A']) {
    assert.throws(() => { let key; try { key = decodeURIComponent(bad); } catch {} groupKey(key); }, { statusCode: 400, code: 'SESSION_GROUP_INVALID' });
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
// Times below are written against a 30-minute TTL; pin it so the Core default can change.

// Real private Store and snapshot duration fallback. Run for current-run event
// aliases or duration changes; skip UI-only edits. Injected Core/CLI observations,
// no live tmux/PM2/network; fixture closes the DB and removes its owned root.

// Integration boundary: supervisor records imported by the real importer into a private Store, read by the real
// snapshot. Run for no-response or automatic-restart changes; skip rendering-only edits. No tmux/network/children.

// Same owned Store/snapshot fixture as the working cases above. Source offsets
// must use the same instant for the visible window and its lookback boundary.

// Real Store, snapshot and activity fixture above; no live resources. Keep
// lifetime transitions visible even when a child emits many tool pairs.

// Real Store/API and activity fixtures: a busy sibling cannot evict another
// child's own freshness, either now or when seeding the visible window.

// Private Store/Core fixtures only: run for working terminal-event queries or
// reduction changes; skip unrelated UI changes. No live runtime/channel starts.
