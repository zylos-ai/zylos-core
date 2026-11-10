import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import * as childProcess from 'node:child_process';
import { Store } from '../src/lib/store.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { ConversationCollector as LegacyConversationCollector } from './fixtures/legacy-conversation-collector.js';
import { claudeProjectSlug } from '../src/lib/claude-project-path.js';
import { StateEngine } from '../src/lib/state-engine.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { workbenchResponse } from '../src/lib/workbench/group-snapshot.js';
import { CoreState } from '../src/lib/core-state.js';

const at = Date.parse('2026-11-06T12:00:00.000Z');
const timestamp = new Date(at).toISOString();

// Local SQLite/files only; snapshots are injected and no runtime services start.
// Run when collection, pricing, deduplication or attribution changes; UI-only
// changes may skip these cases.
function fixture(t, getSnapshot = async () => ({ listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'origin-run' } }] })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-attribution-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { homeDir: dir, zylosDir: dir, runtime: 'claude',
    runtimeModelPrices: {
      claude: { 'claude-example': { input: 2, output: 8, cacheRead: 0.2, cacheCreation: 4 } },
      codex: { 'gpt-5.3-codex': { input: 3, output: 12, cacheRead: 0.3, cacheCreation: 0 } },
    },
    runtimeServiceTierModelPrices: {
      codex: { priority: { 'gpt-5.3-codex': { input: 6, output: 24, cacheRead: 0.6, cacheCreation: 0 } } },
    },
  };
  const transcripts = new UsageTranscripts(store, config, { getSnapshot, now: () => at });
  const claude = new ConversationCollector(store, config, { transcripts });
  const codex = new CodexRolloutCollector(store, config, { transcripts });
  function add(runtime, group, sessionId, lines, runId = `${group}-run`) {
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    store.insertEvent({ id: crypto.randomUUID(), ingest_id: crypto.randomUUID(), timestamp,
      runtime, session_id: sessionId, session_group: group, run_id: runId,
      event_type: 'session_start', category: 'session', source: 'core-log',
      metadata: { transcript_path: file },
    });
    return file;
  }
  return { store, config, transcripts, claude, codex, add, dir };
}

function claudeRequest(id, sessionId, block = 0) {
  return { type: 'assistant', uuid: `${id}-${block}`, requestId: id, sessionId, timestamp,
    message: { id: `message-${id}`, model: 'claude-example',
      content: [{ type: 'text', text: `Result ${id}` }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50,
        cache_creation_input_tokens: 0 },
    },
  };
}

function codexRequest(id, { model = 'gpt-5.3-codex', tier = 'standard' } = {}) {
  return { type: 'event_msg', timestamp, payload: { type: 'token_count', service_tier: tier,
    info: { id, model, last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } },
  } };
}

function usage(store) { return store.queryMetrics({ name: 'usage_event' }); }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

// Entry-module integration: real constructor wiring, inventory and SQLite writes.
// Run for runtime selection or collector wiring changes; skip UI-only changes.
// Requires the isolated runner's HOME/ZYLOS_DIR/PM2_HOME and short private TMPDIR
// and tmux socket. No listener or Core/PM2 child starts; version commands and
// snapshot reads are injected. All import-created intervals and files are owned
// by this case and cleaned even when import or an assertion fails.
test('dashboard constructs both usage collectors when configured for Claude', { timeout: 15000 }, async t => {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    const value = process.env[key];
    assert.ok(value && path.isAbsolute(value), `${key} must be set by the isolated runner`);
    const relative = path.relative(realHome, value);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`), `${key} must be outside the live home`);
  }
  assert.equal(process.env.TMUX, undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-wiring-'));
  const previous = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
  const intervals = new Set();
  const realSetInterval = globalThis.setInterval;
  let engine, coreState;
  t.after(() => {
    for (const timer of intervals) clearInterval(timer);
    engine?.store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = realSetInterval(...args); intervals.add(timer); return timer;
  });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  const childCalls = [];
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess,
    execFileSync: (command, args) => { childCalls.push([command, args]); return '1.0.0'; },
    execFile: () => { assert.fail('usage wiring must not start a Core or PM2 child'); },
  } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  t.mock.module('../src/lib/core-state.js', { namedExports: {
    CoreState: class extends CoreState { constructor(...args) { super(...args); coreState = this; } },
  } });
  let snapshots = 0;
  t.mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: {
    workbenchResponse,
    createGroupSnapshot: () => ({ getSnapshot: async (at, options) => {
      assert.deepEqual(options, { fresh: true }, 'usage lifecycle reads bypass the UI snapshot cache');
      snapshots++; return { listKnown: true, rows: [] };
    } }),
  } });
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
  fs.mkdirSync(path.join(root, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components/dashboard/config.json'), JSON.stringify({
    auth: { enabled: false },
    runtimeModelPrices: { codex: { 'gpt-5.3-codex': { input: 3, output: 12, cacheRead: 0.3, cacheCreation: 0 } } },
  }));
  process.env.HOME = root;
  process.env.ZYLOS_DIR = root;
  console.log('Usage constructor isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    database: path.join(root, 'components/dashboard/dashboard.db'), Core: 'injected', network: 'none' }));
  await import(`../src/index.js?usage-wiring=${crypto.randomUUID()}`);
  assert.equal(engine?._config.runtime, 'claude');
  assert.ok(engine.collectors.conversation instanceof ConversationCollector);
  assert.ok(engine.collectors.codexRollout instanceof CodexRolloutCollector);
  assert.equal(engine.store.db.name, path.join(root, 'components/dashboard/dashboard.db'));
  const file = path.join(root, 'codex-other-group.jsonl');
  fs.writeFileSync(file, JSON.stringify(codexRequest('index-owned')) + '\n');
  engine.store.insertEvent({ id: crypto.randomUUID(), ingest_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(), runtime: 'codex', session_id: 'index-codex',
    session_group: 'other-group', run_id: 'other-run', event_type: 'session_start',
    category: 'session', source: 'core-log', metadata: { transcript_path: file },
  });
  await engine.collectors.conversation.collect();
  await engine.collectors.codexRollout.collect();
  const rows = usage(engine.store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runtime, 'codex');
  assert.equal(rows[0].session_group, 'other-group');
  assert.equal(rows[0].dimensions.run_id, 'other-run');
  near(rows[0].dimensions.cost, (60 * 3 + 40 * 0.3 + 20 * 12) / 1e6);
  assert.equal(snapshots, 1);
  await engine.collectors.conversation.collect();
  assert.equal(snapshots, 1, 'unchanged production CoreState signal reuses the snapshot');
  coreState.costKey = JSON.stringify([['other-group', 'next-run', 'next-session']]);
  await engine.collectors.conversation.collect();
  assert.equal(snapshots, 2, 'the production constructor connects CoreState identity changes to the inventory');
  assert.equal(childCalls.every(([, args]) => args.length === 1 && args[0] === '--version'), true);
});

test('mixed runtime groups use their own prices and combine into one total', async t => {
  const f = fixture(t);
  f.add('claude', 'A', 'claude-a', ['a', 'b', 'c'].flatMap(id =>
    [0, 1, 2].map(block => claudeRequest(id, 'claude-a', block))));
  f.add('codex', 'B', 'codex-b', [codexRequest('standard'), codexRequest('priority', { tier: 'priority' }),
    codexRequest('unknown', { model: 'gpt-reserve' })]);
  await f.claude.collect();
  await f.codex.collect();
  const rows = usage(f.store);
  assert.equal(rows.length, 6);
  const claude = rows.filter(row => row.runtime === 'claude');
  const codex = rows.filter(row => row.runtime === 'codex');
  assert.equal(claude.length, 3);
  assert.equal(codex.length, 3);
  const claudeCost = (100 * 2 + 20 * 8 + 50 * 0.2) / 1e6;
  for (const row of claude) {
    assert.equal(row.session_group, 'A');
    assert.equal(row.dimensions.run_id, 'A-run');
    near(row.dimensions.cost, claudeCost);
  }
  for (const row of codex) {
    assert.equal(row.session_group, 'B');
    assert.equal(row.dimensions.run_id, 'B-run');
  }
  const standardCost = (60 * 3 + 40 * 0.3 + 20 * 12) / 1e6;
  near(codex.find(row => row.dimensions.event_id === 'standard').dimensions.cost, standardCost);
  near(codex.find(row => row.dimensions.event_id === 'priority').dimensions.cost, standardCost * 2);
  assert.equal(codex.find(row => row.dimensions.event_id === 'unknown').dimensions.cost, undefined);
  near(f.store.aggregateCost({ since: '2026-11-06T00:00:00.000Z' }), claudeCost * 3 + standardCost * 3);
  const words = f.store.queryEvents({ types: ['assistant_message'], limit: 20 });
  assert.equal(words.length, 9, 'group A keeps the words of its own transcript lines');
  assert.ok(words.every(row => row.session_group === 'A' && row.run_id === 'A-run'));
});

test('Claude rereads fill empty group attribution without changing an existing group', async t => {
  const f = fixture(t);
  const lines = ['empty-a', 'empty-b', 'owned'].map(id => claudeRequest(id, 'origin-session'));
  const file = f.add('claude', 'origin', 'origin-session', lines, 'origin-run');
  const old = new ConversationCollector(f.store, f.config, { transcripts: f.transcripts });
  old._collectFile(file, { sessionId: 'origin-session', usageOnly: true });
  f.store.db.prepare("UPDATE metric_points SET session_group='A' WHERE json_extract(dimensions,'$.request_id')='owned'").run();
  const original = usage(f.store);
  assert.equal(original.length, 3);
  await f.claude.collect();
  const rows = usage(f.store);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.session_group, row.dimensions.request_id === 'owned' ? 'A' : 'origin');
    assert.equal(row.timestamp, original.find(before => before.id === row.id).timestamp);
  }
});

test('Codex rereads fill empty group attribution while preserving rows and prices', async t => {
  const f = fixture(t);
  const file = f.add('codex', 'B', 'codex-old', [codexRequest('empty'), codexRequest('owned')]);
  const old = new CodexRolloutCollector(f.store, f.config, { transcripts: f.transcripts });
  old.collectMapping({ transcript_path: file, session_id: 'codex-old' });
  f.store.db.prepare("UPDATE metric_points SET session_group='A' WHERE json_extract(dimensions,'$.event_id')='owned'").run();
  const before = usage(f.store);
  f.store.db.prepare('DELETE FROM codex_rollout_cursors').run();
  await f.codex.collect();
  const rows = usage(f.store);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.session_group, row.dimensions.event_id === 'owned' ? 'A' : 'B');
    assert.equal(row.id, before.find(previous => previous.dimensions.event_id === row.dimensions.event_id).id);
    assert.equal(row.dimensions.cost, before.find(previous => previous.id === row.id).dimensions.cost);
  }
});

test('Codex subagent lifecycle and tools retain the parent group and run', async t => {
  const f = fixture(t);
  const response = payload => ({ type: 'response_item', timestamp, payload });
  f.add('codex', 'B', 'codex-agents', [
    response({ type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: JSON.stringify({ agent_type: 'worker', message: 'Inspect files' }) }),
    response({ type: 'function_call_output', call_id: 'spawn', output: JSON.stringify({ agent_id: 'child' }) }),
    response({ type: 'function_call', name: 'close_agent', call_id: 'close', arguments: JSON.stringify({ target: 'child' }) }),
    response({ type: 'function_call_output', call_id: 'close', output: JSON.stringify({ agent_id: 'child' }) }),
  ]);
  await f.codex.collect();
  const events = f.store.queryEvents({ order: 'asc', limit: 20 });
  const lifecycle = events.filter(row => ['subagent_start', 'subagent_stop'].includes(row.event_type));
  assert.equal(lifecycle.length, 2);
  assert.equal(lifecycle[0].event_type, 'subagent_start');
  assert.equal(lifecycle[1].event_type, 'subagent_stop');
  for (const event of events.filter(row => row.source === 'rollout')) {
    assert.equal(event.session_group, 'B');
    assert.equal(event.run_id, 'B-run');
  }
});

test('assistant summaries come from the current Origin run and from other groups\' own transcripts', async t => {
  const f = fixture(t, async () => ({ listKnown: true, rows: [
    { sessionGroup: 'origin', live: { runId: 'origin-run' } },
    { sessionGroup: 'A', live: { runId: 'A-run' } },
    { sessionGroup: 'B', live: { runId: 'B-run' } },
  ] }));
  f.add('claude', 'origin', 'current', [claudeRequest('current', 'current')], 'origin-run');
  f.add('claude', 'origin', 'old', [claudeRequest('old', 'old')], 'old-run');
  f.add('claude', 'A', 'other', [claudeRequest('other', 'other')]);
  f.add('claude', 'B', 'also-current', [claudeRequest('also-current', 'also-current')]);
  await f.claude.collect();
  assert.equal(usage(f.store).length, 4);
  const summaries = f.store.queryEvents({ types: ['assistant_message'] });
  assert.deepEqual(summaries.map(row => [row.session_group, row.session_id, row.run_id]).sort(),
    [['A', 'other', 'A-run'], ['B', 'also-current', 'B-run'], ['origin', 'current', 'origin-run']]);
  const health = f.store.db.prepare("SELECT extra FROM source_health WHERE name='conversation_reader' AND signal_type='collector_liveness'").get();
  assert.equal(JSON.parse(health.extra).messages_ingested, 3);
  assert.equal(f.claude._offsets.size, 0);
});

test('failed usage writes preserve durable cursors and retry the unread request', async t => {
  for (const runtime of ['claude', 'codex']) {
    const f = fixture(t);
    const request = id => runtime === 'claude' ? claudeRequest(id, `${runtime}-session`) : codexRequest(id);
    const file = f.add(runtime, 'origin', `${runtime}-session`, [request('first')], 'origin-run');
    const collector = runtime === 'claude' ? f.claude : f.codex;
    await collector.collect();
    const offset = f.store.getUsageTranscript(file).byte_offset;
    assert.ok(offset > 0);
    fs.appendFileSync(file, JSON.stringify(request('retry')) + '\n');
    const writeMethod = runtime === 'codex' ? 'insertMetricOnce' : 'insertMetric';
    const failingWrite = t.mock.method(f.store, writeMethod, () => { throw new Error('usage write failed'); });
    await assert.rejects(collector.collect(), /usage write failed/, `${runtime} must propagate the failed write`);
    assert.equal(f.store.getUsageTranscript(file).byte_offset, offset);
    assert.equal(f.store.getUsageTranscript(file).status, 'active');
    assert.equal(usage(f.store).length, 1);
    if (runtime === 'codex') assert.equal(f.store.getCodexRolloutCursor(file).byte_offset, offset);
    else assert.equal(collector._offsets.size, 0);
    failingWrite.mock.restore();
    await collector.collect();
    assert.equal(usage(f.store).length, 2);
    assert.equal(f.store.getUsageTranscript(file).byte_offset, fs.statSync(file).size);
    if (runtime === 'codex') assert.equal(f.store.getCodexRolloutCursor(file).byte_offset, fs.statSync(file).size);
    else assert.equal(collector._offsets.size, 0);
  }
});

test('idle Codex groups cannot overwrite the current Origin collector health', async t => {
  const f = fixture(t, async () => ({ listKnown: true, rows: [
    { sessionGroup: 'origin', live: { runId: 'origin-run' } },
    { sessionGroup: 'A', live: { runId: 'A-run' } },
  ] }));
  const origin = f.add('codex', 'origin', 'a-origin', [codexRequest('origin-first')], 'origin-run');
  const idle = f.add('codex', 'A', 'z-idle', [codexRequest('idle-first')]);
  await f.codex.collect();
  fs.appendFileSync(origin, JSON.stringify(codexRequest('origin-next')) + '\n');
  const visited = [];
  const original = f.codex.collectMapping.bind(f.codex);
  t.mock.method(f.codex, 'collectMapping', mapping => { visited.push(mapping.transcript_path); return original(mapping); });
  await f.codex.collect();
  assert.equal(visited.length, 2);
  assert.equal(visited[0], origin);
  assert.equal(visited[1], idle);
  const health = f.store.db.prepare("SELECT status, extra FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get();
  assert.equal(health.status, 'healthy');
  assert.equal(JSON.parse(health.extra).transcript_path, origin);
  assert.equal(usage(f.store).length, 3);
});

test('unreadable snapshots still allow usage without publishing assistant summaries', async t => {
  const f = fixture(t, async () => { throw new Error('snapshot unavailable'); });
  f.add('claude', 'origin', 'current', [claudeRequest('current', 'current')], 'origin-run');
  await f.claude.collect();
  assert.equal(usage(f.store).length, 1);
  assert.equal(f.store.queryEvents({ types: ['assistant_message'] }).length, 0);
});

test('run-scoped Origin statusline reproduces the empty legacy collection and now records usage', async t => {
  const f = fixture(t);
  const file = f.add('claude', 'origin', 'run-scoped', [claudeRequest('origin-request', 'run-scoped')], 'origin-run');
  const statusDir = path.join(f.dir, 'activity-monitor', 'session-groups', 'origin');
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(path.join(statusDir, 'statusline.json'), JSON.stringify({ session_id: 'run-scoped' }));
  const legacy = new LegacyConversationCollector(f.store, f.config);
  const projectDir = legacy._resolveProjectDir();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(file, path.join(projectDir, 'run-scoped.jsonl'));
  assert.equal(fs.existsSync(path.join(f.dir, 'activity-monitor', 'statusline.json')), false);
  assert.equal(legacy.collect(), 0);
  assert.equal(usage(f.store).length, 0);
  await f.claude.collect();
  const rows = usage(f.store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_group, 'origin');
  assert.equal(rows[0].dimensions.run_id, 'origin-run');
  near(rows[0].dimensions.cost, (100 * 2 + 20 * 8 + 50 * 0.2) / 1e6);
});

test('legacy statusline fallback records the same usage as the frozen collector', async t => {
  const f = fixture(t);
  const sessionId = 'legacy-session';
  const projectDir = path.join(f.dir, '.claude', 'projects', claudeProjectSlug(f.dir));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(f.dir, 'activity-monitor'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'activity-monitor', 'statusline.json'), JSON.stringify({ session_id: sessionId }));
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`),
    ['first', 'second'].map(id => JSON.stringify(claudeRequest(id, sessionId))).join('\n') + '\n');
  const control = new Store(path.join(f.dir, 'legacy-control.db'));
  try {
    const legacy = new LegacyConversationCollector(control, f.config);
    legacy.collect();
    await f.claude.collect();
    const before = usage(control), after = usage(f.store);
    assert.equal(before.length, 2);
    assert.equal(after.length, 2);
    for (let i = 0; i < after.length; i++) {
      const actual = after[i], expected = before[i];
      assert.equal(actual.session_group, null);
      assert.equal(actual.session_id, expected.session_id);
      assert.equal(actual.timestamp, expected.timestamp);
      assert.equal(actual.runtime, expected.runtime);
      assert.equal(actual.metric_value, expected.metric_value);
      const { run_id, ...dimensions } = actual.dimensions;
      assert.equal(run_id, null);
      assert.deepEqual(dimensions, expected.dimensions);
    }
    const entries = f.store.db.prepare('SELECT * FROM usage_transcripts').all();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].session_group, null);
    assert.equal(entries[0].run_id, null);
  } finally { control.close(); }
});
