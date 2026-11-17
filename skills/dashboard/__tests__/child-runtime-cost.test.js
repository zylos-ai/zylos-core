import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { CoreLogImporter, childTranscriptMapping } from '../src/lib/core-log-importer.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { createHistoryScope } from '../src/lib/history/history-scope.js';
import { costRows } from '../src/lib/workbench/cost-query.js';
import { migrateDatabase } from '../src/lib/schema.js';

const at = Date.parse('2026-11-17T08:00:00.000Z');
const timestamp = new Date(at).toISOString();

// Local SQLite and files only: snapshots are injected, no service, timer or
// runtime starts. Run when child cost records, transcript registration or the
// collectors' message/activity rules change; UI-only changes can skip it.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-runtime-cost-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  const importer = new CoreLogImporter({ store, zylosDir: dir });
  t.after(async () => { await importer.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { homeDir: dir, zylosDir: dir, runtime: 'claude',
    runtimeModelPrices: {
      claude: { 'claude-example': { input: 2, output: 8, cacheRead: 0.2, cacheCreation: 4 } },
      codex: { 'gpt-5.3-codex': { input: 3, output: 12, cacheRead: 0.3, cacheCreation: 0 } },
    },
  };
  const snapshot = async () => ({ listKnown: true, rows: [{ sessionGroup: 'g1', live: { runId: 'run-1' } }] });
  const transcripts = new UsageTranscripts(store, config, { getSnapshot: snapshot, now: () => at });
  return {
    dir, store, importer, transcripts,
    claude: new ConversationCollector(store, config, { transcripts }),
    codex: new CodexRolloutCollector(store, config, { transcripts }),
    write(relative, rows) {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      return file;
    },
  };
}

const claudeLine = (id, sessionId) => ({ type: 'assistant', uuid: id, requestId: id, sessionId, timestamp,
  message: { id: `message-${id}`, model: 'claude-example', content: [{ type: 'text', text: `child words ${id}` }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const codexLines = sessionId => [
  { type: 'session_meta', timestamp, payload: { id: sessionId } },
  { type: 'turn_context', timestamp, payload: { model: 'gpt-5.3-codex' } },
  { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child words' }] } },
  { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"ls"}' } },
  { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { id: 'tc-1', last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } } },
];

test('child cost records register cost-only transcripts under the child runtime', async t => {
  const f = fixture(t);
  const claudeFile = f.write('.claude/projects/p/child-claude.jsonl', [claudeLine('req-1', 'child-claude')]);
  const codexFile = f.write('.codex/sessions/2026/11/17/rollout-child-codex.jsonl', codexLines('child-codex'));
  const record = (runtime, sessionId, file, group = 'g1') => ({ v: 1, ts: at, runtime, session_group: group, run_id: 'run-1', session_id: sessionId, transcript_path: file });
  f.write('activity-monitor/session-groups/g1/child-sessions.jsonl', [record('claude', 'child-claude', claudeFile), record('codex', 'child-codex', codexFile)]);
  f.write('activity-monitor/child-sessions.jsonl', [{ ...record('claude', 'child-legacy', path.join(f.dir, 'legacy.jsonl'), null), run_id: null }]);

  const sources = await f.importer.discover();
  for (const stream of ['children', 'children:g1']) assert.ok(sources.some(source => source.stream === stream), stream);
  for (const source of sources.filter(item => item.stream.startsWith('children'))) await f.importer.importStream(source);

  const rows = f.store.db.prepare('SELECT session_id, runtime, kind, session_group, run_id FROM usage_transcripts ORDER BY session_id').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { session_id: 'child-claude', runtime: 'claude', kind: 'child', session_group: 'g1', run_id: 'run-1' },
    { session_id: 'child-codex', runtime: 'codex', kind: 'child', session_group: 'g1', run_id: 'run-1' },
    { session_id: 'child-legacy', runtime: 'claude', kind: 'child', session_group: null, run_id: null },
  ]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runtime_events').get().n, 0, 'no activity event is created');
  assert.deepEqual(f.store.childSessionIds().sort(), ['child-claude', 'child-codex', 'child-legacy']);

  await f.claude.collect();
  await f.codex.collect();
  const usage = f.store.queryMetrics({ name: 'usage_event' });
  assert.deepEqual(usage.map(point => [point.runtime, point.session_id]).sort(), [['claude', 'child-claude'], ['codex', 'child-codex']]);
  const events = f.store.db.prepare('SELECT event_type FROM runtime_events').all().map(row => row.event_type);
  assert.deepEqual(events, [], 'no assistant message, tool step or turn activity');

  const cost = costRows(f.store, { since: '2026-11-17T00:00:00.000Z', until: '2026-11-18T00:00:00.000Z', bucket: 'total' });
  assert.deepEqual(cost.map(row => row.runtime).sort(), ['claude', 'codex'], 'each child is costed under its own runtime');
  assert.ok(cost.every(row => row.value > 0));
});

test('child transcripts never become a current or group main transcript', async t => {
  const f = fixture(t);
  const file = f.write('.claude/projects/p/child-origin.jsonl', [claudeLine('req-2', 'child-origin')]);
  f.store.insertUsageTranscript({ transcript_path: file, runtime: 'claude', session_group: 'origin', run_id: 'run-1', session_id: 'child-origin', kind: 'child' }, timestamp);
  assert.equal(f.store.currentOriginTranscript('claude', 'run-1'), null);
  await f.claude.collect();
  assert.equal(f.store.queryMetrics({ name: 'usage_event' }).length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM runtime_events WHERE event_type = 'assistant_message'").get().n, 0);
});

test('Observer history excludes child sessions from every group', async t => {
  const f = fixture(t);
  f.store.insertUsageTranscript({ transcript_path: path.join(f.dir, 'c.jsonl'), runtime: 'claude', session_group: 'origin', session_id: 'child-x', kind: 'child' }, timestamp);
  const load = async name => (name === 'config.js'
    ? { readSessionMode: () => ({ mode: 'multi' }) }
    : { assertSessionGroup: group => group });
  const scope = createHistoryScope({ config: { zylosDir: f.dir }, store: f.store, load });
  for (const group of ['origin', 'g1']) {
    const result = await scope(new URLSearchParams({ session_group: group }));
    assert.ok(result.excludedSessionIds.has('child-x'), group);
  }
});

test('a child resuming a main session id leaves that session in Observer history', async t => {
  const f = fixture(t);
  f.store.insertUsageTranscript({ transcript_path: path.join(f.dir, 'main.jsonl'), runtime: 'claude', session_group: 'g1', session_id: 'main-1' }, timestamp);
  f.store.insertUsageTranscript({ transcript_path: path.join(f.dir, 'resumed.jsonl'), runtime: 'claude', session_group: 'g1', session_id: 'main-1', kind: 'child' }, timestamp);
  f.store.insertUsageTranscript({ transcript_path: path.join(f.dir, 'c.jsonl'), runtime: 'claude', session_group: 'g1', session_id: 'child-x', kind: 'child' }, timestamp);
  assert.deepEqual(f.store.childSessionIds(), ['child-x']);
  const load = async name => (name === 'config.js'
    ? { readSessionMode: () => ({ mode: 'multi' }) }
    : { assertSessionGroup: group => group });
  const result = await createHistoryScope({ config: { zylosDir: f.dir }, store: f.store, load })(new URLSearchParams({ session_group: 'g1' }));
  assert.equal(result.excludedSessionIds.has('main-1'), false);
  assert.equal(result.excludedSessionIds.has('child-x'), true);
});

test('finished child rows outlive the finished-session retention', async t => {
  const f = fixture(t);
  for (const [name, kind] of [['session', 'session'], ['child', 'child']]) {
    f.store.insertUsageTranscript({ transcript_path: path.join(f.dir, `${name}.jsonl`), runtime: 'claude', session_id: name, kind }, '2026-01-01T00:00:00.000Z');
    f.store.updateUsageTranscript(path.join(f.dir, `${name}.jsonl`), { status: 'finished', now: '2026-01-01T00:00:00.000Z' });
  }
  f.store.pruneUsageTranscripts('2026-06-01T00:00:00.000Z');
  assert.deepEqual(f.store.db.prepare('SELECT session_id FROM usage_transcripts').all().map(row => row.session_id), ['child']);
});

test('malformed child records are rejected with a warning', () => {
  const good = { v: 1, ts: 1, runtime: 'codex', session_id: 's', transcript_path: '/h/.codex/s.jsonl', session_group: 'g1', run_id: 'r' };
  assert.equal(childTranscriptMapping(good).mapping.kind, 'child');
  assert.equal(childTranscriptMapping({ ...good, v: 2 }).warning, 'unknown_version');
  for (const bad of [{ runtime: 'gemini' }, { session_id: '' }, { transcript_path: 'relative.jsonl' }, { transcript_path: '/h/s.txt' }]) {
    assert.deepEqual(childTranscriptMapping({ ...good, ...bad }), { warning: 'invalid_record' });
  }
});

test('the schema migration adds the transcript kind to an existing database', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-runtime-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dashboard.db');
  const store = new Store(file);
  const transcript = path.join(dir, 'old.jsonl');
  store.insertUsageTranscript({ transcript_path: transcript, runtime: 'claude', session_id: 'old' }, timestamp);
  store.close();

  const db = new Database(file);
  t.after(() => db.close());
  db.exec('ALTER TABLE usage_transcripts DROP COLUMN kind');
  db.prepare('DELETE FROM schema_migrations WHERE version = 28').run();
  migrateDatabase(db);
  assert.equal(db.prepare('SELECT kind FROM usage_transcripts WHERE transcript_path = ?').get(transcript).kind, 'session');
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 28').get());
  migrateDatabase(db);
  assert.throws(() => db.prepare("INSERT INTO usage_transcripts (transcript_path, runtime, session_id, first_seen_at, updated_at, kind) VALUES ('x', 'claude', 's', 'a', 'a', 'other')").run(),
    /CHECK constraint/);
});
