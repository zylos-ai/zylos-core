import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { usageSummary } from '../src/lib/workbench/usage-api.js';
import { usageSeries } from '../src/lib/workbench/usage-series.js';

const at = Date.parse('2026-11-17T08:00:00.000Z');
const timestamp = new Date(at).toISOString();
const now = new Date('2026-11-17T12:00:00.000Z');
const c4Reader = { getMessageSeries: () => ({ points: [], total: { in: 0, out: 0 } }) };
const round = value => Math.round(value * 1e9) / 1e9;

// Local SQLite and files only: no service, timer, runtime or browser starts.
// Run when child cost records, the collectors' usage samples or the usage
// readers' group scopes change; UI-only changes can skip it.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-usage-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  const importer = new CoreLogImporter({ store, zylosDir: dir });
  t.after(async () => { await importer.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { homeDir: dir, zylosDir: dir, runtime: 'claude',
    runtimeModelPrices: {
      claude: { 'claude-example': { input: 2, output: 8, cacheRead: 0.2, cacheCreation: 4 } },
      codex: { 'gpt-5.3-codex': { input: 3, output: 12, cacheRead: 0.3, cacheCreation: 0 } },
    },
  };
  const transcripts = new UsageTranscripts(store, config, {
    getSnapshot: async () => ({ listKnown: true, rows: [{ sessionGroup: 'g1', live: { runId: 'run-1' } }] }), now: () => at });
  const write = (relative, rows) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return file;
  };
  return { dir, store, importer, write,
    claude: new ConversationCollector(store, config, { transcripts }),
    codex: new CodexRolloutCollector(store, config, { transcripts }) };
}

const claudeLine = (id, sessionId, input) => ({ type: 'assistant', uuid: id, requestId: id, sessionId, timestamp,
  message: { id: `message-${id}`, model: 'claude-example', content: [{ type: 'text', text: 'words' }],
    usage: { input_tokens: input, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const codexLines = (sessionId, input) => [
  { type: 'session_meta', timestamp, payload: { id: sessionId } },
  { type: 'turn_context', timestamp, payload: { model: 'gpt-5.3-codex' } },
  { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { id: `tc-${sessionId}`,
    last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 20 } } } },
];
const claudeCost = input => (input * 2 + 20 * 8) / 1e6;
const codexCost = input => (input * 3 + 20 * 12) / 1e6;

// Four kinds of samples, each with its own size so every total names its parts:
// - zylos started a Claude and a Codex child itself (no group, no run): "Other";
// - an agent in g1 ran `claude -p` (group g1, run-1): g1;
// - an agent in single-session mode ran `claude -p` (a run, no group): Origin;
// - a groupless sample from before child records existed: Origin, as before.
async function collectAll(f) {
  const record = (runtime, sessionId, file, group, run) => ({ v: 1, ts: at, runtime, session_group: group, run_id: run,
    session_id: sessionId, transcript_path: file });
  const zylosClaude = f.write('.claude/projects/p/zylos-claude.jsonl', [claudeLine('req-zylos', 'zylos-claude', 1000)]);
  const zylosCodex = f.write('.codex/sessions/2026/11/17/rollout-zylos-codex.jsonl', codexLines('zylos-codex', 2000));
  const agentChild = f.write('.claude/projects/p/agent-child.jsonl', [claudeLine('req-agent', 'agent-child', 3000)]);
  const singleChild = f.write('.claude/projects/p/single-child.jsonl', [claudeLine('req-single', 'single-child', 4000)]);
  f.write('activity-monitor/child-sessions.jsonl', [
    record('claude', 'zylos-claude', zylosClaude, null, null), record('codex', 'zylos-codex', zylosCodex, null, null),
    record('claude', 'single-child', singleChild, null, 'run-s')]);
  f.write('activity-monitor/session-groups/g1/child-sessions.jsonl', [record('claude', 'agent-child', agentChild, 'g1', 'run-1')]);
  for (const source of (await f.importer.discover()).filter(item => item.stream.startsWith('children'))) await f.importer.importStream(source);
  await f.claude.collect();
  await f.codex.collect();
  f.store.insertMetric({ timestamp, runtime: 'claude', session_id: 'old-main', session_group: null, metric_name: 'usage_event',
    metric_value: 5000, dimensions: { total_input: 5000, output: 20, cost: claudeCost(5000), request_id: 'req-old' },
    source: 'jsonl_usage', confidence: 'actual' });
}

const expected = {
  other: claudeCost(1000) + codexCost(2000),
  g1: claudeCost(3000),
  origin: claudeCost(4000) + claudeCost(5000),
};

test('runtimes zylos starts itself count as Other: in the instance total, in no group', async t => {
  const f = fixture(t);
  await collectAll(f);
  const marked = f.store.db.prepare("SELECT session_id FROM metric_points WHERE metric_name = 'usage_event' AND json_extract(dimensions, '$.child') IS 1 ORDER BY session_id").all();
  assert.deepEqual(marked.map(row => row.session_id), ['agent-child', 'single-child', 'zylos-claude', 'zylos-codex'], 'every child sample is marked, and only those');

  const series = usageSeries(f.store, c4Reader, { range: '7d', tz: 'UTC', now });
  assert.equal(round(series.totals.otherCost), round(expected.other));
  assert.equal(round(series.totals.cost), round(expected.other + expected.g1 + expected.origin), 'the instance total is unchanged');

  const origin = usageSummary(f.store, { tz: 'UTC', now, group: 'origin' }).sevenDay;
  const g1 = usageSummary(f.store, { tz: 'UTC', now, group: 'g1' }).sevenDay;
  const all = usageSummary(f.store, { tz: 'UTC', now }).sevenDay;
  assert.equal(round(origin.cost), round(expected.origin), 'Origin keeps run-carrying and legacy groupless samples, not Other');
  assert.equal(round(g1.cost), round(expected.g1), 'an agent child stays in its group');
  assert.equal(origin.inputTokens, 4000 + 5000, 'Origin tokens leave Other out as well');
  assert.equal(g1.inputTokens, 3000);
  // The instance total is every group plus Other, over the same records and bounds.
  assert.equal(round(all.cost), round(origin.cost + g1.cost + series.totals.otherCost));
  assert.equal(round(all.cost), round(series.totals.cost));
});
