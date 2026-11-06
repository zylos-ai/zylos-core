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

const DAY = 86400000;
function fixture(t, snapshot = { rows: [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  let clock = Date.parse('2026-11-06T12:00:00Z');
  const inventory = new UsageTranscripts(store, { homeDir: root, zylosDir: root },
    { now: () => clock, getSnapshot: async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; } });
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
  assert.equal(f.store.latestCodexRolloutPath().transcript_path, c);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM source_health').get().n, 0);
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
  fs.writeFileSync(path.join(other.root, 'activity-monitor', 'statusline.json'), JSON.stringify({ session_id: id }));
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
  for (const snapshot of [{ rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] }, new Error('offline')]) {
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
  f.inventory.getSnapshot = async () => { await ready; return { rows: [] }; };
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
  assert.equal(health.status, 'healthy');
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
  const snapshot = { rows: [{ sessionGroup: 'origin', live: { runId: 'run-origin' } }] };
  const f = fixture(t, snapshot), p = f.file('origin-codex');
  fs.writeFileSync(p, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }) + '\n');
  fs.utimesSync(p, new Date(f.now()), new Date(f.now()));
  f.start(p, 'origin', 'codex');
  const collector = new CodexRolloutCollector(f.store, { zylosDir: f.root }, { transcripts: f.inventory });
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  snapshot.rows[0].live.runId = 'replacement';
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().session_id, null);
  assert.equal(collector.getRuntimeInfo().model_id, undefined);
  snapshot.rows[0].live.runId = 'run-origin';
  await collector.collect();
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  fs.unlinkSync(p); await collector.collect();
  assert.equal(collector.getRuntimeInfo().session_id, null);
  assert.equal(collector.getRuntimeInfo().model_id, undefined);
});
