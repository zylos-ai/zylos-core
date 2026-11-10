import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { claudeProjectSlug } from '../src/lib/claude-project-path.js';
import { latestCodexRolloutSessionBounds } from '../src/lib/metric-aggregate.js';
import { CodexHistory } from '../src/lib/history/codex-history.js';

// All cases use actual SQLite/files and collectors. Run for transcript discovery,
// snapshot scheduling or attribution changes; skip unrelated UI changes. The official
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR before imports; no services, network,
// tmux sessions or child processes are started. Each fixture closes/removes its DB.
const privateHome = fs.realpathSync(process.env.HOME);
const ownerHome = fs.realpathSync(os.userInfo().homedir);
assert.notEqual(privateHome, ownerHome);
assert.ok(!privateHome.startsWith(ownerHome + path.sep));
const isolationRoot = path.dirname(privateHome);
for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  const target = process.env[key];
  assert.ok(target, `${key} must be set`);
  const resolved = fs.existsSync(target) ? fs.realpathSync(target)
    : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  assert.ok(resolved.startsWith(isolationRoot + path.sep), `${key} must be private`);
}
assert.ok(Buffer.byteLength(path.join(process.env.TMPDIR, 'test.sock')) < 104);
console.log('Transcript test isolation:', JSON.stringify({ HOME: privateHome,
  ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME,
  TMPDIR: process.env.TMPDIR, database: 'per-fixture temporary dashboard.db',
  tmux: 'no tmux commands or sessions', children: 'none', network: 'none' }));

const DAY = 86400000;
function fixture(t, snapshot = { listKnown: true, rows: [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  let clock = Date.parse('2026-11-06T12:00:00Z');
  const inventory = new UsageTranscripts(store, { homeDir: root, zylosDir: root },
    { now: () => clock,
      getSnapshotKey: () => snapshot instanceof Error ? null : JSON.stringify(snapshot?.rows ?? []),
      getSnapshot: async () => { if (snapshot instanceof Error) throw snapshot; return structuredClone(snapshot); } });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = name => {
    const p = path.join(root, `${name}.jsonl`); fs.writeFileSync(p, '');
    fs.utimesSync(p, new Date(clock), new Date(clock));
    return p;
  };
  const start = (p, group, runtime = 'claude', at = clock) => store.insertEvent({
    id: `${group}-${runtime}-${at}-${Math.random()}`, ingest_id: `${Math.random()}`, timestamp: new Date(at).toISOString(),
    runtime, session_id: `session-${group}`, session_group: group, run_id: `run-${group}`,
    event_type: 'session_start', category: 'session', metadata: { transcript_path: p }, source: 'core-log', confidence: 'actual',
  });
  return { root, store, inventory, file, start, now: () => clock, advance: n => { clock += n; } };
}

test('discovery preserves first attribution, finds subagents and rejects invalid or old starts', t => {
  const f = fixture(t), a = f.file('a'), b = f.file('b'), c = f.file('c');
  f.start(a, 'A'); f.start(b, 'B'); f.start(c, 'C', 'codex');
  f.start(a, 'elsewhere', 'claude', f.now() + 1);
  f.start('relative.jsonl', 'bad'); f.start(path.join(f.root, 'not-text.txt'), 'bad2');
  f.start(f.file('old'), 'old', 'claude', f.now() - 9 * DAY);
  const dir = path.join(f.root, 'session-A', 'subagents'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-one.jsonl'), ''); fs.writeFileSync(path.join(dir, 'agent-two.jsonl'), '');
  f.inventory.discover();
  assert.equal(f.store.activeUsageTranscripts().length, 5);
  assert.equal(f.store.getUsageTranscript(a).session_group, 'A');
  assert.equal(f.store.getUsageTranscript(path.join(dir, 'agent-one.jsonl')).parent_path, a);
  assert.equal(f.store.latestCodexRolloutPath(), null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM source_health').get().n, 0);
});

function codexGroups(t) {
  const f = fixture(t);
  const dir = path.join(f.root, '.codex', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, group] of [null, 'origin', 'b'].entries()) {
    const timestamp = new Date(f.now() - (3 - index) * 1000).toISOString();
    const file = path.join(dir, `rollout-${group}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'session_meta', timestamp, payload: { id: `session-${group}` } },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
        model: 'gpt-5.3-codex', last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
      } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.utimesSync(file, new Date(timestamp), new Date(timestamp));
    f.start(file, group, 'codex', Date.parse(timestamp));
  }
  f.inventory.discover();
  return f;
}

// SQLite/file integration with real inventory and collectors, no services or children.
// Run for Codex discovery/attribution changes; skip unrelated UI changes. The runner
// isolates HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR and tmux socket; fixture cleanup
// closes its temporary DB and removes its transcript files even on failure.
test('Codex discovery keeps only Origin rollout paths while collecting every group cost', async t => {
  const f = codexGroups(t);
  const collector = new CodexRolloutCollector(f.store, { homeDir: f.root, zylosDir: f.root,
    runtimeModelPrices: { codex: { 'gpt-5.3-codex': { input: 3, output: 12, cacheRead: 0.3, cacheCreation: 0 } } },
  }, { transcripts: f.inventory });
  await collector.collect();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM usage_transcripts').get().n, 3);
  for (const group of [null, 'origin', 'b']) {
    const file = path.join(f.root, '.codex', 'sessions', `rollout-${group}.jsonl`);
    const row = f.store.getUsageTranscript(file);
    assert.equal(row.session_group, group);
    assert.equal(row.session_id, `session-${group}`);
    assert.equal(row.byte_offset, fs.statSync(file).size);
    assert.ok(f.store.aggregateCost({ sessionId: `session-${group}` }) > 0);
  }
  const paths = f.store.db.prepare('SELECT session_id FROM codex_rollout_paths ORDER BY session_id').all();
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map(row => row.session_id), ['session-null', 'session-origin']);
});

// SQLite/inventory/metric integration: newer non-Origin starts must not select the
// session fallback. Run for discovery or fallback selection changes; skip UI-only
// changes. Same isolated runner and temporary fixture cleanup as the case above.
test('Codex session metric fallback selects the latest Origin despite a newer group', t => {
  const f = codexGroups(t);
  assert.equal(latestCodexRolloutSessionBounds(f.store).sessionId, 'session-origin');
});

// SQLite/inventory/history integration: real rollout metadata under a private HOME.
// Run for discovery or history selection changes; skip unrelated UI changes. Same
// isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/tmux socket and fixture cleanup as above.
test('Codex history excludes other groups and marks the latest Origin current', async t => {
  const f = codexGroups(t);
  const history = new CodexHistory({ store: f.store, homeDir: f.root, zylosDir: f.root });
  const result = await history.listSessions();
  assert.equal(result.current, 'session-origin');
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(result.sessions.map(row => row.id).sort(), ['session-null', 'session-origin']);
});

test('legacy discovery adopts saved file offsets and yields to explicit Claude starts', t => {
  const f = fixture(t), id = 'legacy';
  fs.mkdirSync(path.join(f.root, 'activity-monitor'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'activity-monitor', 'statusline.json'), JSON.stringify({ session_id: id }));
  const dir = path.join(f.root, '.claude', 'projects', claudeProjectSlug(f.root)); fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.jsonl`); fs.writeFileSync(p, ' '.repeat(1000));
  f.store.upsertSourceHealth('conversation_reader', 'byte_offset', 'tracking', { files: { [p]: 1000 } });
  f.inventory.discover();
  assert.equal(f.store.getUsageTranscript(p).byte_offset, 1000);
  assert.equal(f.store.getUsageTranscript(p).session_group, null);
  const other = fixture(t), explicit = other.file('explicit');
  fs.mkdirSync(path.join(other.root, 'activity-monitor'), { recursive: true });
  fs.writeFileSync(path.join(other.root, 'activity-monitor', 'statusline.json'), JSON.stringify({ session_id: 'session-A' }));
  const otherDir = path.join(other.root, '.claude', 'projects', claudeProjectSlug(other.root));
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'session-A.jsonl'), '{}\n');
  other.start(explicit, 'A'); other.inventory.discover();
  assert.equal(other.store.activeUsageTranscripts().length, 1);
});

// SQLite/file lifecycle integration: own DB and temporary transcript files;
// snapshots are injected. Run for inventory scheduling/cursor changes; skip UI
// changes. No child processes, network, live HOME, PM2 or tmux resources.
test('shared rounds cap both runtimes at fifty and rotate unchanged files', async t => {
  const f = fixture(t), seen = [];
  for (let i = 0; i < 60; i++) f.start(f.file(String(i).padStart(2, '0')), `g${i}`, i % 2 ? 'codex' : 'claude');
  f.inventory.discover(); f.advance(1);
  const growing = path.join(f.root, '59.jsonl');
  for (let round = 0; round < 6; round++) {
    fs.appendFileSync(growing, 'x');
    fs.utimesSync(growing, new Date(f.now()), new Date(f.now()));
    const thisRound = [];
    for (const runtime of ['claude', 'codex']) await f.inventory.collect(runtime, row => {
      thisRound.push(row.transcript_path); return { written: 0, byteOffset: fs.statSync(row.transcript_path).size };
    });
    assert.equal(thisRound.length, 50); seen.push(thisRound);
    for (const file of thisRound) assert.equal(f.store.getUsageTranscript(file).updated_at, new Date(f.now()).toISOString());
    f.advance(5000);
  }
  for (let i = 0; i < seen.length - 1; i++) assert.equal(new Set([...seen[i], ...seen[i + 1]]).size, 60);
  for (let i = 0; i < seen.length - 1; i++) assert.ok(seen[i].includes(growing) || seen[i + 1].includes(growing));
});

test('missing files recover without losing attribution or cursor and ended files expire', async t => {
  const f = fixture(t), p = f.file('missing'); f.start(p, 'A'); f.inventory.discover();
  f.store.updateUsageTranscript(p, { byte_offset: 12, now: new Date(f.now()).toISOString() });
  fs.unlinkSync(p); await f.inventory.collect('claude', () => assert.fail('missing file read'));
  const missing = f.store.getUsageTranscript(p); assert.equal(missing.status, 'missing');
  f.advance(60000); f.inventory.discover();
  assert.equal(f.store.getUsageTranscript(p).status, 'missing');
  assert.equal(f.store.getUsageTranscript(p).updated_at, missing.updated_at);
  fs.writeFileSync(p, ' '.repeat(12)); f.advance(60000); f.inventory.discover();
  const restored = f.store.getUsageTranscript(p);
  assert.equal(restored.status, 'active'); assert.equal(restored.session_group, 'A');
  assert.equal(restored.byte_offset, 12); assert.equal(restored.updated_at, missing.updated_at);
  await f.inventory.collect('claude', row => {
    assert.equal(row.byte_offset, 12);
    return { byteOffset: row.byte_offset };
  });
  fs.utimesSync(p, new Date(f.now() - DAY), new Date(f.now() - DAY));
  await f.inventory.collect('claude', row => ({ byteOffset: row.byte_offset }));
  assert.equal(f.store.getUsageTranscript(p).status, 'finished');
  f.advance(9 * DAY); f.inventory.discover(); assert.equal(f.store.getUsageTranscript(p), null);
});

test('current runs remain active and unavailable snapshots suppress finishing and summaries', async t => {
  for (const snapshot of [{ listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] }, new Error('offline')]) {
    const f = fixture(t, snapshot), p = f.file('current'); f.start(p, 'origin');
    fs.utimesSync(p, new Date(f.now() - DAY), new Date(f.now() - DAY));
    await f.inventory.collect('claude', (row, current) => {
      assert.equal(current, !(snapshot instanceof Error)); return { byteOffset: 0 };
    });
    assert.equal(f.store.getUsageTranscript(p).status, 'active');
  }
});

test('discovery excludes historical groups and prunes only expired inactive rows', async t => {
  const f = fixture(t);
  f.store.db.transaction(() => {
    for (let i = 0; i < 10000; i++) f.start(path.join(f.root, `absent-${i}.jsonl`), `old-${i}`, 'claude', f.now() - 30 * DAY);
  })();
  for (let i = 0; i < 3; i++) f.start(f.file(`recent-${i}`), `recent-${i}`);
  const add = (name, status, age) => {
    const p = path.join(f.root, `${name}.jsonl`);
    f.store.insertUsageTranscript({ transcript_path: p, runtime: 'claude', session_id: name }, new Date(f.now() - age).toISOString());
    f.store.updateUsageTranscript(p, { status, now: new Date(f.now() - age).toISOString() });
    return p;
  };
  const expired = add('expired', 'finished', 9 * DAY), missing = add('missing', 'missing', 9 * DAY);
  const retained = add('retained', 'finished', 8 * DAY - 60000), active = add('active', 'active', 30 * DAY);
  f.inventory.discover();
  assert.equal(f.store.getUsageTranscript(expired), null); assert.equal(f.store.getUsageTranscript(missing), null);
  assert.equal(f.store.getUsageTranscript(retained).status, 'finished');
  assert.equal(f.store.getUsageTranscript(active).status, 'active');
  assert.equal(f.store.activeUsageTranscripts().length, 4);
  let reads = 0;
  await f.inventory.collect('claude', () => { reads++; return { byteOffset: 0 }; });
  assert.equal(reads, 3);
});

test('overlapping polls share their pending runtime pass', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const f = fixture(t), p = f.file('pending'); f.start(p, 'A');
  f.inventory.getSnapshot = async () => { await ready; return { listKnown: true, rows: [] }; };
  let reads = 0;
  const collect = () => f.inventory.collect('claude', () => { reads++; return { written: 1, byteOffset: 0 }; });
  const first = collect();
  f.advance(10000);
  const next = collect();
  assert.equal(first, next);
  release();
  assert.equal(await first, 1); assert.equal(reads, 1);
});

test('saved offsets skip historical requests and resume after a missing file returns', async t => {
  const f = fixture(t), p = f.file('offset');
  const request = (id, timestamp) => JSON.stringify({ type: 'assistant', requestId: id, uuid: id,
    timestamp, sessionId: 'session-A', message: { model: 'claude-example', content: [],
      usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n';
  const oldAt = new Date(f.now() - DAY).toISOString();
  const old = request('old', oldAt);
  fs.writeFileSync(p, old + ' '.repeat(999 - Buffer.byteLength(old)) + '\n');
  fs.utimesSync(p, new Date(f.now()), new Date(f.now()));
  f.store.insertMetric({ timestamp: oldAt, runtime: 'claude', session_id: 'session-A',
    metric_name: 'usage_event', metric_value: 10, source: 'jsonl_usage',
    dimensions: { request_id: 'old', input_tokens: 10, output_tokens: 2 } });
  f.store.upsertSourceHealth('conversation_reader', 'byte_offset', 'tracking', { files: { [p]: 1000 } });
  f.start(p, 'A');
  const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root }, { transcripts: f.inventory });
  await collector.collect();
  assert.equal(f.store.getUsageTranscript(p).byte_offset, 1000);
  assert.equal(f.store.queryMetrics({ name: 'usage_event' })[0].timestamp, oldAt);
  assert.equal(f.store.queryMetrics({ name: 'usage_event' })[0].session_group, null);
  fs.unlinkSync(p); await collector.collect();
  assert.equal(f.store.getUsageTranscript(p).status, 'missing');
  fs.writeFileSync(p, old + ' '.repeat(999 - Buffer.byteLength(old)) + '\n' + request('new', new Date(f.now()).toISOString()));
  f.advance(60000); f.inventory.discover();
  await collector.collect();
  const rows = f.store.queryMetrics({ name: 'usage_event' });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.dimensions.request_id === 'old').timestamp, oldAt);
  assert.equal(rows.find(row => row.dimensions.request_id === 'new').session_group, 'A');
  assert.equal(f.store.getUsageTranscript(p).byte_offset, fs.statSync(p).size);
  const health = f.store.db.prepare("SELECT status FROM source_health WHERE name='conversation_reader' AND signal_type='collector_liveness'").get();
  assert.equal(health, undefined);
  assert.equal(collector._offsets.size, 0);
});

test('historical groups cause no transcript file accesses', async t => {
  const f = fixture(t), recent = new Set();
  f.store.db.transaction(() => {
    for (let i = 0; i < 10000; i++) f.start(path.join(f.root, `historical-${i}.jsonl`), `old-${i}`, 'claude', f.now() - 30 * DAY);
  })();
  for (let i = 0; i < 3; i++) {
    const p = f.file(`recent-counted-${i}`); recent.add(p);
    fs.writeFileSync(p, '{}\n'); f.start(p, `current-${i}`);
  }
  const stats = new Set(), reads = new Set();
  const stat = fs.statSync, open = fs.openSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (String(file).endsWith('.jsonl')) { assert.ok(recent.has(file)); stats.add(file); }
    return stat(file, ...args);
  });
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).endsWith('.jsonl')) { assert.ok(recent.has(file)); reads.add(file); }
    return open(file, ...args);
  });
  const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root }, { transcripts: f.inventory });
  await collector.collect();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM usage_transcripts').get().n, 3);
  assert.equal(stats.size, 3); assert.equal(reads.size, 3);
});

test('Codex runtime metadata clears when the Origin run changes or its file disappears', async t => {
  const snapshot = { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] };
  const f = fixture(t, snapshot), p = f.file('origin-codex');
  fs.writeFileSync(p, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }) + '\n');
  fs.utimesSync(p, new Date(f.now()), new Date(f.now()));
  f.start(p, 'origin', 'codex');
  const collector = new CodexRolloutCollector(f.store, { zylosDir: f.root }, { transcripts: f.inventory });
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  f.advance(60000);
  snapshot.rows[0].live.runId = 'replacement';
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().session_id, null);
  assert.equal(collector.getRuntimeInfo().model_id, undefined);
  f.advance(60000);
  snapshot.rows[0].live.runId = 'run-origin';
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  fs.unlinkSync(p); await collector.collect();
  assert.equal(collector.getRuntimeInfo().session_id, null);
  assert.equal(collector.getRuntimeInfo().model_id, undefined);
});

test('failed snapshots retain established Codex runtime facts until current evidence returns', async t => {
  const snapshot = { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] };
  const f = fixture(t, snapshot), p = f.file('origin-metadata');
  fs.writeFileSync(p, [
    { type: 'session_meta', payload: { cli_version: '1.0.0' } },
    { type: 'turn_context', payload: { model: 'gpt-5.3-codex', effort: 'high', service_tier: 'priority' } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  f.start(p, 'origin', 'codex');
  const collector = new CodexRolloutCollector(f.store, { zylosDir: f.root }, { transcripts: f.inventory });
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  assert.equal(collector.getRuntimeInfo().cli_version, '1.0.0');
  f.inventory.getSnapshot = async () => { throw new Error('status unavailable'); };
  f.inventory.getSnapshotKey = () => 'changed';
  f.advance(5000);
  await collector.collect();
  assert.equal(f.inventory.snapshot, null);
  const retained = collector.getRuntimeInfo();
  assert.equal(retained.session_id, 'session-origin');
  assert.equal(retained.model_id, 'gpt-5.3-codex');
  assert.equal(retained.reasoning_effort, 'high');
  assert.equal(retained.service_tier, 'priority');
  assert.equal(retained.cli_version, '1.0.0');
  f.inventory.getSnapshot = async () => snapshot;
  snapshot.rows[0].live.runId = 'replacement';
  f.advance(5000);
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().model_id, undefined);
  assert.equal(collector.getRuntimeInfo().session_id, null);
});

test('unchanged session identities reuse snapshots across discovery rounds until ten minutes', async t => {
  const f = fixture(t), p = f.file('snapshot-cache'); f.start(p, 'origin');
  let calls = 0, discoveries = 0;
  const discover = f.inventory.discover.bind(f.inventory);
  t.mock.method(f.inventory, 'discover', at => { discoveries++; return discover(at); });
  f.inventory.getSnapshot = async () => { calls++; return { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] }; };
  for (let i = 0; i < 120; i++) {
    await f.inventory.collect('claude', () => ({ byteOffset: 0 }));
    await f.inventory.collect('codex', () => assert.fail('no Codex file'));
    assert.equal(calls, 1, `poll ${i} before fallback`);
    f.advance(5000);
  }
  assert.equal(discoveries, 10);
  await f.inventory.collect('claude', () => ({ byteOffset: 0 }));
  assert.equal(calls, 2);
  assert.equal(discoveries, 11);
});

// Identity transitions must affect the next poll, independently of 60s discovery.
test('session start and end keys refresh on the next poll and preserve run attribution', async t => {
  const snapshot = { listKnown: true, rows: [] };
  const f = fixture(t, snapshot), old = f.file('old-origin'), next = f.file('next-origin');
  f.start(old, 'origin');
  f.store.insertEvent({ id: 'next-start', ingest_id: 'next-start', timestamp: new Date(f.now()).toISOString(),
    runtime: 'claude', session_id: 'next-session', session_group: 'origin', run_id: 'next-run',
    event_type: 'session_start', category: 'session', metadata: { transcript_path: next }, source: 'core-log', confidence: 'actual' });
  let calls = 0;
  f.inventory.getSnapshot = async () => { calls++; return structuredClone(snapshot); };
  const seen = new Map();
  const poll = async () => {
    seen.clear();
    await f.inventory.collect('claude', (row, current) => { seen.set(row.transcript_path, current); return { byteOffset: 0 }; });
  };
  await poll();
  assert.equal(seen.get(old), false); assert.equal(seen.get(next), false);
  snapshot.rows = [{ sessionGroup: 'origin', live: { runId: 'run-origin', sessionId: 'session-origin' } }];
  f.advance(5000); await poll();
  assert.equal(calls, 2); assert.equal(seen.get(old), true); assert.equal(seen.get(next), false);
  snapshot.rows[0].live = { runId: 'next-run', sessionId: 'next-session' };
  f.advance(5000); await poll();
  assert.equal(calls, 3); assert.equal(seen.get(old), false); assert.equal(seen.get(next), true);
  snapshot.rows[0].live = null;
  f.advance(5000); await poll();
  assert.equal(calls, 4); assert.equal(seen.get(old), false); assert.equal(seen.get(next), false);
});

for (const signal of ['stuck', 'null', 'throws']) {
  test(`ten minute fallback refreshes when the session signal is ${signal}`, async t => {
    const snapshot = { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] };
    const f = fixture(t, snapshot), p = f.file('fallback'); f.start(p, 'origin');
    f.inventory.getSnapshotKey = () => { if (signal === 'throws') throw new Error('signal unavailable'); return signal === 'null' ? null : 'unchanged'; };
    let calls = 0;
    f.inventory.getSnapshot = async () => { calls++; return structuredClone(snapshot); };
    const poll = expected => f.inventory.collect('claude', (row, current) => { assert.equal(current, expected); return { byteOffset: 0 }; });
    await poll(true);
    snapshot.rows[0].live = null;
    f.advance(599999); await poll(true); assert.equal(calls, 1);
    f.advance(1); await poll(false); assert.equal(calls, 2);
  });
}

for (const unavailable of ['null', 'throws']) {
  test(`temporary ${unavailable} live signals reuse the last identity until fallback or a real change`, async t => {
    const snapshot = { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] };
    const f = fixture(t, snapshot), p = f.file('signal-loss'); f.start(p, 'origin');
    let key = 'running', calls = 0;
    f.inventory.getSnapshotKey = () => {
      if (key === null && unavailable === 'throws') throw new Error('signal unavailable');
      return key;
    };
    f.inventory.getSnapshot = async () => { calls++; return structuredClone(snapshot); };
    const poll = current => f.inventory.collect('claude', (row, actual) => {
      assert.equal(actual, current); return { byteOffset: 0 };
    });
    await poll(true);
    for (let round = 0; round < 6; round++) {
      key = round % 2 === 0 ? null : 'running'; f.advance(5000);
      await poll(true);
      assert.equal(calls, 1, `temporary signal loss on poll ${round}`);
    }
    key = 'ended'; snapshot.rows[0].live = null; f.advance(5000);
    await poll(false); assert.equal(calls, 2);
    key = null; f.advance(5000);
    await poll(false); assert.equal(calls, 2);
    f.advance(595000);
    await poll(false); assert.equal(calls, 3);
  });
}

test('clock rollback refreshes the snapshot without waiting for fallback', async t => {
  const f = fixture(t); let calls = 0;
  f.inventory.getSnapshot = async () => { calls++; return { listKnown: true, rows: [] }; };
  await f.inventory.collect('claude', () => assert.fail('no files'));
  f.advance(-1);
  await f.inventory.collect('claude', () => assert.fail('no files'));
  assert.equal(calls, 2); assert.equal(f.inventory._snapshotAt, f.now());
});

for (const staleRun of ['run-origin', 'ended-run']) {
  for (const signal of ['live key', 'persisted lifecycle']) {
    test(`identity changing during snapshot read accepts ${staleRun} evidence from ${signal} and retries next poll`, { timeout: 1000 }, async t => {
      const f = fixture(t), p = f.file('transition'); f.start(p, 'origin');
      let key = 'before', calls = 0, release, began;
      const entered = new Promise(resolve => { began = resolve; });
      const ready = new Promise(resolve => { release = resolve; });
      t.after(() => release());
      f.inventory.getSnapshotKey = () => signal === 'live key' ? key : null;
      f.inventory.getSnapshot = async () => {
        calls++;
        const candidate = { listKnown: true, rows: [{ sessionGroup: 'origin', live: {
          runId: calls === 1 ? staleRun : 'run-origin',
        } }] };
        if (calls === 1) { began(); await ready; }
        return candidate;
      };
      const first = f.inventory.collect('claude', (row, current) => {
        assert.equal(current, staleRun === 'run-origin'); return { byteOffset: 0 };
      });
      await entered;
      if (signal === 'live key') key = 'after';
      else lifecycleEvent(f, 'rotate_done');
      release(); await first;
      assert.equal(f.inventory.snapshot.rows[0].live.runId, staleRun);
      assert.equal(f.inventory._snapshotAt, f.now());
      assert.equal(f.inventory._snapshotKey, undefined);
      assert.equal(f.store.getUsageTranscript(p).status, 'active');
      f.advance(5000);
      await f.inventory.collect('claude', (row, current) => { assert.equal(current, true); return { byteOffset: 0 }; });
      assert.equal(calls, 2); assert.equal(f.inventory.snapshot.listKnown, true);
    });
  }
}

// SQLite event identity integration: existing Core events must invalidate even
// when Origin is asleep and the sampled live key is null. No new Core API is used.
function lifecycleEvent(f, type, source = 'core-log') {
  const id = `${source}-${type}-${Math.random()}`;
  f.store.insertEvent({ id, ingest_id: id, timestamp: new Date(f.now()).toISOString(),
    runtime: 'claude', session_id: 'group-session', session_group: 'other-group', run_id: 'group-run',
    event_type: type, category: 'session', metadata: {}, source, confidence: 'actual' });
  return id;
}

test('persisted Core lifecycle events refresh on the next poll while the live key is unavailable', async t => {
  const f = fixture(t);
  f.inventory.getSnapshotKey = () => null;
  let calls = 0;
  f.inventory.getSnapshot = async () => { calls++; return { listKnown: true, rows: [] }; };
  const poll = () => f.inventory.collect('claude', () => assert.fail('no files'));
  await poll(); assert.equal(calls, 1);
  // Starts, switches, reclamation/end, manual restart and stop all reuse existing
  // persisted Core event types; each must independently trigger within five seconds.
  const types = ['session_start', 'activate_new', 'start_always', 'activate_continuation',
    'adopt_ready', 'activate_failed', 'activate_timeout', 'reclaim_done', 'rotate_done',
    'crash_detected', 'manual_restart_done', 'unowned_start_stopped'];
  for (const [index, type] of types.entries()) {
    lifecycleEvent(f, type); f.advance(5000); await poll();
    assert.equal(calls, index + 2, type);
  }
});

test('replacing a persisted lifecycle event with a reused sequence still refreshes the snapshot', async t => {
  const f = fixture(t);
  f.inventory.getSnapshotKey = () => null;
  let calls = 0;
  f.inventory.getSnapshot = async () => { calls++; return { listKnown: true, rows: [] }; };
  const first = lifecycleEvent(f, 'session_start');
  const sequence = f.store.db.prepare('SELECT event_seq FROM runtime_events WHERE id=?').get(first).event_seq;
  await f.inventory.collect('claude', () => assert.fail('no files'));
  f.store.db.prepare('DELETE FROM runtime_events WHERE id=?').run(first);
  const replacement = lifecycleEvent(f, 'rotate_done');
  assert.equal(f.store.db.prepare('SELECT event_seq FROM runtime_events WHERE id=?').get(replacement).event_seq, sequence);
  f.advance(5000);
  await f.inventory.collect('claude', () => assert.fail('no files'));
  assert.equal(calls, 2);
});

test('tool turn pool and non-Core lifecycle events do not refresh run snapshots', async t => {
  const f = fixture(t);
  f.inventory.getSnapshotKey = () => null;
  let calls = 0;
  f.inventory.getSnapshot = async () => { calls++; return { listKnown: true, rows: [] }; };
  const poll = () => f.inventory.collect('claude', () => assert.fail('no files'));
  await poll();
  for (const [type, source] of [['pre_tool_use', 'core-log'], ['post_tool_use', 'core-log'], ['stop', 'core-log'],
    ['pool_sample', 'core-log'], ['session_start', 'conversation'], ['rotate_done', 'hook']]) {
    lifecycleEvent(f, type, source); f.advance(5000); await poll();
    assert.equal(calls, 1, `${source}/${type}`);
  }
});

// Real Store/collector integration: unreadable scheduling metadata cannot veto
// valid Core facts or discard assistant messages as cursors advance. Run for
// lifecycle-key error handling or snapshot acceptance changes; skip UI changes.
// Runner/fixtures isolate all files and databases; no services, tmux or children.
for (const failureAt of ['before snapshot', 'after snapshot']) {
  test(`unreadable lifecycle storage ${failureAt} accepts valid snapshots and retries until the key recovers`, async t => {
    const f = fixture(t), p = f.file('unreadable-lifecycle'); f.start(p, 'origin');
    let calls = 0, readError = false;
    assert.ok(f.inventory._lifecycleSequence == null, 'lifecycle statement is prepared only on the first read');
    f.inventory.getSnapshotKey = () => null;
    f.inventory.getSnapshot = async () => {
      calls++;
      if (calls === 2 && failureAt === 'after snapshot') readError = true;
      return { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] };
    };
    const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root }, { transcripts: f.inventory });
    const poll = async id => {
      fs.appendFileSync(p, JSON.stringify({ type: 'assistant', uuid: id, requestId: id,
        sessionId: 'session-origin', timestamp: new Date(f.now()).toISOString(),
        message: { model: 'claude-example', content: [{ type: 'text', text: id }],
          usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n');
      fs.utimesSync(p, new Date(f.now()), new Date(f.now()));
      await collector.collect();
      const message = f.store.queryEvents({ types: ['assistant_message'] }).find(row => row.summary === id);
      assert.ok(message, `valid current snapshot preserves ${id}`);
      assert.equal(message.session_id, 'session-origin');
      assert.equal(message.run_id, 'run-origin');
      const usage = f.store.queryMetrics({ name: 'usage_event' }).find(row => row.dimensions.request_id === id);
      assert.ok(usage, `usage retained for ${id}`);
      assert.equal(usage.session_id, 'session-origin');
      assert.equal(usage.dimensions.run_id, 'run-origin');
      assert.equal(f.store.getUsageTranscript(p).byte_offset, fs.statSync(p).size);
    };
    await poll('before-storage-error');
    const statement = f.inventory._lifecycleSequence;
    const get = statement.get.bind(statement);
    t.mock.method(statement, 'get', (...args) => {
      if (readError) throw new Error('lifecycle storage unavailable');
      return get(...args);
    });
    if (failureAt === 'before snapshot') readError = true;
    else lifecycleEvent(f, 'reclaim_done');
    for (let round = 0; round < 2; round++) {
      f.advance(5000); await poll(`during-storage-error-${round + 1}`);
      assert.equal(f.inventory.snapshot.listKnown, true);
      assert.equal(f.inventory._snapshotAt, f.now());
      assert.equal(f.inventory._snapshotKey, undefined);
      assert.equal(f.store.getUsageTranscript(p).status, 'active');
      assert.equal(calls, round + 2);
    }
    readError = false; f.advance(5000); await poll('after-storage-recovery');
    assert.equal(calls, 4);
    assert.equal(f.inventory.snapshot.listKnown, true);
    assert.notEqual(f.inventory._snapshotKey, undefined);
    f.advance(5000); await poll('after-cached-recovery');
    assert.equal(calls, 4, 'healthy matching key caches the recovered snapshot');
    const messages = f.store.queryEvents({ types: ['assistant_message'] });
    for (const id of ['before-storage-error', 'during-storage-error-1', 'during-storage-error-2',
      'after-storage-recovery', 'after-cached-recovery']) {
      assert.ok(messages.some(row => row.summary === id), `retained message ${id}`);
    }
  });
}

// Real collector/SQLite integration: lifecycle keys gate current summaries while
// usage retains each transcript's own session/run attribution, including late writes.
test('session rotation keeps old and new usage on their own runs and authorizes only current summaries', async t => {
  const snapshot = { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] };
  const f = fixture(t, snapshot), old = f.file('usage-old'), next = f.file('usage-next');
  f.start(old, 'origin');
  f.store.insertEvent({ id: 'usage-next-start', ingest_id: 'usage-next-start', timestamp: new Date(f.now()).toISOString(),
    runtime: 'claude', session_id: 'next-session', session_group: 'origin', run_id: 'next-run',
    event_type: 'session_start', category: 'session', metadata: { transcript_path: next }, source: 'core-log', confidence: 'actual' });
  const append = (file, session, id) => {
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: id, requestId: id, sessionId: session,
      timestamp: new Date(f.now()).toISOString(), message: { model: 'claude-example',
        content: [{ type: 'text', text: id }], usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n');
    fs.utimesSync(file, new Date(f.now()), new Date(f.now()));
  };
  const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root }, { transcripts: f.inventory });
  append(old, 'session-origin', 'old-current'); append(next, 'next-session', 'next-before-start');
  await collector.collect();
  snapshot.rows[0].live.runId = 'next-run'; f.advance(5000);
  append(old, 'session-origin', 'old-late'); append(next, 'next-session', 'next-current');
  await collector.collect();
  const summaries = f.store.queryEvents({ types: ['assistant_message'] });
  assert.equal(summaries.length, 2);
  assert.equal(summaries.find(row => row.summary === 'old-current')?.run_id, 'run-origin');
  assert.equal(summaries.find(row => row.summary === 'next-current')?.run_id, 'next-run');
  const usage = f.store.queryMetrics({ name: 'usage_event' });
  assert.equal(usage.length, 4);
  for (const row of usage) {
    const oldRun = row.dimensions.request_id.startsWith('old-');
    assert.equal(row.session_id, oldRun ? 'session-origin' : 'next-session');
    assert.equal(row.dimensions.run_id, oldRun ? 'run-origin' : 'next-run');
  }
});

// Real Store/collector integration covers cursor advancement while unrelated Core
// lifecycle events arrive during every snapshot read. Run for snapshot acceptance,
// retry scheduling or assistant attribution changes; skip unrelated UI changes.
// The runner and fixture isolate all paths; no services, tmux or children are used.
test('continuous unrelated lifecycle changes preserve every Origin assistant message and each run usage', async t => {
  const snapshot = { listKnown: true, rows: [
    { sessionGroup: 'origin', live: { runId: 'run-origin' } },
    { sessionGroup: 'other-group', live: { runId: 'run-other-group' } },
  ] };
  const f = fixture(t, snapshot), origin = f.file('continuous-origin'), other = f.file('continuous-other');
  f.start(origin, 'origin'); f.start(other, 'other-group');
  let calls = 0, churn = true;
  f.inventory.getSnapshotKey = () => 'unchanged-live-identity';
  f.inventory.getSnapshot = async () => {
    calls++;
    const candidate = structuredClone(snapshot);
    await Promise.resolve();
    if (churn) lifecycleEvent(f, calls % 2 ? 'session_start' : 'reclaim_done');
    return candidate;
  };
  const append = (file, group, id) => {
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: id, requestId: id,
      sessionId: `session-${group}`, timestamp: new Date(f.now()).toISOString(),
      message: { model: 'claude-example', content: [{ type: 'text', text: id }],
        usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n');
    fs.utimesSync(file, new Date(f.now()), new Date(f.now()));
  };
  const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root }, { transcripts: f.inventory });
  const expected = ['steady', ...Array.from({ length: 6 }, (_, index) => `during-change-${index + 1}`), 'final'];
  for (const [index, id] of expected.entries()) {
    churn = id !== 'final';
    append(origin, 'origin', `origin-${id}`); append(other, 'other-group', `other-${id}`);
    await collector.collect();
    assert.equal(calls, index + 1, `fresh snapshot for ${id}`);
    const messages = f.store.queryEvents({ types: ['assistant_message'] });
    const message = messages.find(row => row.summary === `origin-${id}`);
    assert.ok(message, `Origin message survives the pending-read change: ${id}`);
    assert.equal(message.session_id, 'session-origin');
    assert.equal(message.run_id, 'run-origin');
    assert.equal(f.store.getUsageTranscript(origin).byte_offset, fs.statSync(origin).size);
    f.advance(5000);
  }
  const messages = f.store.queryEvents({ types: ['assistant_message'] });
  const usage = f.store.queryMetrics({ name: 'usage_event' });
  assert.equal(usage.length, expected.length * 2);
  for (const id of expected) {
    assert.ok(messages.some(row => row.summary === `origin-${id}`), `retained Origin message ${id}`);
    for (const [prefix, group] of [['origin', 'origin'], ['other', 'other-group']]) {
      const row = usage.find(item => item.dimensions.request_id === `${prefix}-${id}`);
      assert.ok(row, `usage row ${prefix}-${id}`);
      assert.equal(row.session_id, `session-${group}`);
      assert.equal(row.dimensions.run_id, `run-${group}`);
    }
  }
  await collector.collect();
  assert.equal(calls, expected.length, 'stable final candidate is cached');
});

test('discovery refreshes a recovered snapshot before reading a new Origin transcript', async t => {
  const f = fixture(t);
  let calls = 0, currentRun = 'old-run';
  f.inventory.getSnapshotKey = () => currentRun;
  f.inventory.getSnapshot = async () => {
    calls++;
    if (calls === 1) throw new Error('snapshot unavailable');
    return { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: currentRun } }] };
  };
  const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root }, { transcripts: f.inventory });
  await collector.collect();
  assert.equal(f.inventory.snapshot, null);
  f.advance(5000);
  await collector.collect();
  assert.equal(calls, 2);
  f.advance(55000);
  currentRun = 'run-origin';
  const file = f.file('new-origin');
  fs.writeFileSync(file, ['s1', 's2'].map(id => JSON.stringify({
    type: 'assistant', uuid: id, sessionId: 'session-origin', timestamp: new Date(f.now()).toISOString(),
    message: { content: [{ type: 'text', text: id }] },
  })).join('\n') + '\n');
  f.start(file, 'origin');
  await collector.collect();
  assert.equal(calls, 3);
  const summaries = f.store.queryEvents({ types: ['assistant_message'], order: 'asc' });
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].summary, 's1');
  assert.equal(summaries[1].summary, 's2');
  assert.equal(f.store.getUsageTranscript(file).byte_offset, fs.statSync(file).size);
  await collector.collect();
  assert.equal(f.store.queryEvents({ types: ['assistant_message'] }).length, 2);
  assert.equal(calls, 3);
});

test('incomplete and failed status snapshots suppress finishing and current attribution without caching', async t => {
  for (const snapshot of [
    new Error('snapshot unavailable'),
    null,
    { listKnown: false, reason: 'group_list_failed', rows: [{ sessionGroup: 'origin', live: null }] },
    { rows: [] },
    { listKnown: false, sources: { status: { ok: false } }, rows: [{ sessionGroup: 'origin', live: null }] },
  ]) {
    const f = fixture(t, snapshot), p = f.file('incomplete'); f.start(p, 'origin');
    fs.utimesSync(p, new Date(f.now() - DAY), new Date(f.now() - DAY));
    let calls = 0;
    f.inventory.getSnapshot = async () => { calls++; if (snapshot instanceof Error) throw snapshot; return snapshot; };
    for (let i = 0; i < 2; i++) {
      await f.inventory.collect('claude', (row, current) => {
        assert.equal(current, false); return { byteOffset: 0 };
      });
      f.advance(5000);
    }
    assert.equal(calls, 2);
    assert.equal(f.store.getUsageTranscript(p).status, 'active');
    assert.equal(f.inventory.snapshot, null);
  }
});

test('files with unread bytes remain active until the recorded cursor reaches their end', async t => {
  const f = fixture(t), p = f.file('backlog'); f.start(p, 'B', 'codex');
  fs.writeFileSync(p, 'x'.repeat(300000));
  fs.utimesSync(p, new Date(f.now() - DAY), new Date(f.now() - DAY));
  await f.inventory.collect('codex', () => ({ byteOffset: 256000 }));
  assert.equal(f.store.getUsageTranscript(p).status, 'active');
  assert.equal(f.store.getUsageTranscript(p).byte_offset, 256000);
  await f.inventory.collect('codex', row => {
    assert.equal(row.byte_offset, 256000); return { byteOffset: 300000 };
  });
  assert.equal(f.store.getUsageTranscript(p).status, 'finished');
});

test('bounded Codex replay keeps an old transcript active until its final request is read', async t => {
  const f = fixture(t), p = f.file('bounded-backlog');
  const event = id => ({ type: 'event_msg', payload: { type: 'token_count', info: {
    id, model: 'gpt-5.3-codex', last_token_usage: { input_tokens: 10, output_tokens: 2 },
  } } });
  fs.writeFileSync(p, ['first', 'second'].map(id => JSON.stringify(event(id))).join('\n') + '\n');
  fs.utimesSync(p, new Date(f.now() - DAY), new Date(f.now() - DAY));
  f.start(p, 'B', 'codex');
  const collector = new CodexRolloutCollector(f.store, { zylosDir: f.root, codexRolloutMaxLinesPerCollect: 1 }, { transcripts: f.inventory });
  await collector.collect();
  const partial = f.store.getUsageTranscript(p);
  assert.equal(partial.status, 'active');
  assert.ok(partial.byte_offset > 0 && partial.byte_offset < fs.statSync(p).size);
  assert.equal(f.store.queryMetrics({ name: 'usage_event' }).length, 1);
  await collector.collect();
  assert.equal(f.store.getUsageTranscript(p).status, 'finished');
  assert.equal(f.store.getUsageTranscript(p).byte_offset, fs.statSync(p).size);
  assert.equal(f.store.queryMetrics({ name: 'usage_event' }).length, 2);
});

test('Codex path discovery retains the latest Origin session across repeated discoveries', t => {
  const f = fixture(t), older = f.file('codex-older'), newer = f.file('codex-newer');
  f.start(older, null, 'codex', f.now() - 10000);
  f.start(newer, 'origin', 'codex');
  f.inventory.discover();
  assert.equal(f.store.latestCodexRolloutPath().transcript_path, newer);
  const upserts = [];
  const original = f.store.upsertCodexRolloutPath.bind(f.store);
  t.mock.method(f.store, 'upsertCodexRolloutPath', mapping => { upserts.push(mapping); return original(mapping); });
  f.advance(60000); f.inventory.discover();
  assert.equal(upserts.length, 0);
  assert.equal(f.store.latestCodexRolloutPath().transcript_path, newer);
});

test('legacy statusline rotation discovers the new file and only it is current Origin', async t => {
  const f = fixture(t), statusDir = path.join(f.root, 'activity-monitor');
  const projectDir = path.join(f.root, '.claude', 'projects', claudeProjectSlug(f.root));
  fs.mkdirSync(statusDir, { recursive: true }); fs.mkdirSync(projectDir, { recursive: true });
  const status = path.join(statusDir, 'statusline.json');
  fs.writeFileSync(path.join(projectDir, 'legacy-first.jsonl'), '{}\n');
  fs.writeFileSync(status, JSON.stringify({ session_id: 'legacy-first' }));
  const current = [];
  await f.inventory.collect('claude', (row, originCurrent) => {
    assert.equal(originCurrent, true); return { byteOffset: 0 };
  });
  fs.writeFileSync(path.join(projectDir, 'legacy-next.jsonl'), '{}\n');
  fs.writeFileSync(status, JSON.stringify({ session_id: 'legacy-next' }));
  f.advance(60000);
  await f.inventory.collect('claude', (row, originCurrent) => {
    current.push([row.session_id, originCurrent]); return { byteOffset: 0 };
  });
  assert.equal(f.store.activeUsageTranscripts().length, 2);
  assert.equal(current.find(([id]) => id === 'legacy-first')[1], false);
  assert.equal(current.find(([id]) => id === 'legacy-next')[1], true);
});

test('legacy Origin discovery coexists with an explicit session in another group', async t => {
  const f = fixture(t, { listKnown: true, rows: [
    { sessionGroup: 'origin', live: { runId: null } },
    { sessionGroup: 'A', live: { runId: 'run-A' } },
  ] });
  const explicit = f.file('new-group'); f.start(explicit, 'A');
  const projectDir = path.join(f.root, '.claude', 'projects', claudeProjectSlug(f.root));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(f.root, 'activity-monitor'), { recursive: true });
  const legacy = path.join(projectDir, 'legacy-origin.jsonl');
  fs.writeFileSync(legacy, '{}\n');
  fs.writeFileSync(path.join(f.root, 'activity-monitor', 'statusline.json'), JSON.stringify({ session_id: 'legacy-origin' }));
  const seen = new Map();
  await f.inventory.collect('claude', (row, current) => {
    seen.set(row.transcript_path, current); return { byteOffset: fs.statSync(row.transcript_path).size };
  });
  assert.equal(seen.size, 2);
  assert.equal(seen.get(legacy), true);
  assert.equal(seen.get(explicit), false);
  assert.equal(f.store.getUsageTranscript(legacy).session_group, null);
  assert.equal(f.store.getUsageTranscript(explicit).session_group, 'A');
});

test('rotated legacy sessions finish after idle EOF while the current legacy remains active', async t => {
  const f = fixture(t, { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: null } }] });
  const projectDir = path.join(f.root, '.claude', 'projects', claudeProjectSlug(f.root));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(f.root, 'activity-monitor'), { recursive: true });
  const status = path.join(f.root, 'activity-monitor', 'statusline.json');
  const first = path.join(projectDir, 'one.jsonl'), next = path.join(projectDir, 'two.jsonl');
  fs.writeFileSync(first, '{}\n');
  fs.utimesSync(first, new Date(f.now()), new Date(f.now()));
  fs.writeFileSync(status, JSON.stringify({ session_id: 'one' }));
  const read = row => ({ byteOffset: fs.statSync(row.transcript_path).size });
  await f.inventory.collect('claude', read);
  assert.equal(f.store.getUsageTranscript(first).status, 'active');
  f.advance(60000);
  fs.writeFileSync(next, '{}\n');
  fs.utimesSync(next, new Date(f.now()), new Date(f.now()));
  fs.writeFileSync(status, JSON.stringify({ session_id: 'two' }));
  await f.inventory.collect('claude', read);
  assert.equal(f.store.getUsageTranscript(first).status, 'active');
  f.advance(5 * 3600000);
  await f.inventory.collect('claude', read);
  assert.equal(f.store.getUsageTranscript(first).status, 'finished');
  assert.equal(f.store.getUsageTranscript(next).status, 'active');
  f.advance(9 * DAY);
  await f.inventory.collect('claude', read);
  assert.equal(f.store.getUsageTranscript(first), null);
  assert.equal(f.store.getUsageTranscript(next).status, 'active');
});

for (const [runtime, statusline, title] of [
  ['codex', 'other', 'legacy Codex stays collectible with an unrelated Claude statusline'],
  ['codex', 'absent', 'legacy Codex stays collectible without a Claude statusline'],
  ['claude', 'absent', 'legacy Claude stays collectible without a statusline'],
  ['claude', 'invalid', 'legacy Claude stays collectible when the statusline cannot be parsed'],
]) {
  test(title, async t => {
    const f = fixture(t, { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: null } }] });
    const file = f.file('legacy-current');
    if (statusline !== 'absent') {
      fs.mkdirSync(path.join(f.root, 'activity-monitor'), { recursive: true });
      fs.writeFileSync(path.join(f.root, 'activity-monitor', 'statusline.json'), statusline === 'other'
        ? JSON.stringify({ session_id: 'unrelated-claude' }) : '{');
    }
    f.store.insertUsageTranscript({ transcript_path: file, runtime, session_id: 'legacy-current' },
      new Date(f.now()).toISOString());
    const request = id => runtime === 'claude'
      ? { type: 'assistant', requestId: id, uuid: id, sessionId: 'legacy-current',
        timestamp: new Date(f.now()).toISOString(), message: { model: 'claude-example', content: [],
          usage: { input_tokens: 10, output_tokens: 2 } } }
      : { type: 'event_msg', timestamp: new Date(f.now()).toISOString(), payload: { type: 'token_count',
        info: { id, model: 'gpt-5.3-codex', last_token_usage: { input_tokens: 10, output_tokens: 2 } } } };
    const append = id => {
      fs.appendFileSync(file, JSON.stringify(request(id)) + '\n');
      fs.utimesSync(file, new Date(f.now()), new Date(f.now()));
    };
    const Collector = runtime === 'claude' ? ConversationCollector : CodexRolloutCollector;
    const collector = new Collector(f.store, { homeDir: f.root, zylosDir: f.root }, { transcripts: f.inventory });
    append('before-idle');
    await collector.collect();
    assert.equal(f.store.queryMetrics({ name: 'usage_event' }).length, 1);
    assert.equal(f.store.getUsageTranscript(file).byte_offset, fs.statSync(file).size);
    f.advance(40 * 60000);
    await collector.collect();
    assert.equal(f.store.getUsageTranscript(file).status, 'active');
    append('after-idle');
    await collector.collect();
    assert.equal(f.store.queryMetrics({ name: 'usage_event' }).length, 2);
    assert.equal(f.store.getUsageTranscript(file).status, 'active');
    assert.equal(f.store.getUsageTranscript(file).byte_offset, fs.statSync(file).size);
    await collector.collect();
    assert.equal(f.store.queryMetrics({ name: 'usage_event' }).length, 2);
  });
}
