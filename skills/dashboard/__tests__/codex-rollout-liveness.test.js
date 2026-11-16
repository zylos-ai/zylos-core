import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { Store } from '../src/lib/store.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';

function harness(t, config = {}, { sessionGroup = 'origin' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-liveness-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const snapshot = { listKnown: true, rows: [{ sessionGroup, live: { runId: null } }] };
  let clock = Date.now();
  let snapshotError = null;
  let snapshotCalls = 0;
  const transcripts = new UsageTranscripts(store, { homeDir: dir, zylosDir: dir }, {
    now: () => clock, getSnapshot: async () => {
      snapshotCalls++;
      if (snapshotError) throw snapshotError;
      return snapshot;
    },
  });
  const collector = new CodexRolloutCollector(store, { ...config, zylosDir: dir }, { transcripts });
  return {
    collector, store, transcripts,
    get snapshotCalls() { return snapshotCalls; },
    failSnapshot() {
      snapshotError = new Error('Snapshot source unavailable');
      clock += 10 * 60000 + 1;
    },
    select(session, events) {
      const filename = path.join(dir, `${session}.jsonl`);
      fs.writeFileSync(filename, events.map(event => JSON.stringify(event) + '\n').join(''));
      this.map(session, filename);
      return filename;
    },
    map(session, filename) {
      clock++;
      snapshot.rows[0].live.runId = `run-${session}`;
      store.insertEvent({ id: `start-${clock}`, ingest_id: `start-${clock}`, timestamp: new Date(clock).toISOString(),
        runtime: 'codex', session_id: session, session_group: 'origin', run_id: `run-${session}`,
        event_type: 'session_start', category: 'session', source: 'core-log', metadata: { transcript_path: filename } });
      transcripts.discover(clock);
    },
  };
}

const turn = payload => ({ type: 'turn_context', payload });

// SQLite/transcript integration with injected snapshots only. Run for collector
// metadata or inventory wiring changes; UI-only changes can skip. The isolated
// runner supplies HOME/ZYLOS_DIR/PM2_HOME/private short TMPDIR and tmux directory.
// This case owns its database/files and starts no services, processes or timers.
test('same-run replacement collects the newest Origin file first and preserves current liveness', async t => {
  const h = harness(t);
  const previous = h.select('same-run', [turn({ model: 'old-model' })]);
  await h.collector.collect();
  const replacement = path.join(path.dirname(previous), 'aaa-replacement.jsonl');
  fs.writeFileSync(replacement, JSON.stringify(turn({ model: 'new-model' })) + '\n');
  h.map('same-run', replacement);
  h.store.updateUsageTranscript(previous, { now: h.store.getUsageTranscript(replacement).updated_at });
  const visited = [];
  const collectMapping = h.collector.collectMapping.bind(h.collector);
  t.mock.method(h.collector, 'collectMapping', mapping => {
    visited.push([mapping.transcript_path, mapping.isOriginCurrent]);
    return collectMapping(mapping);
  });
  await h.collector.collect();
  assert.equal(visited[0][0], replacement);
  assert.equal(visited.find(([file]) => file === previous)[1], false);
  const health = h.store.db.prepare("SELECT status, extra FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get();
  assert.equal(health.status, 'healthy');
  assert.equal(JSON.parse(health.extra).transcript_path, replacement);
});

test('a complete snapshot without a current Origin mapping marks liveness unavailable on the first poll', async t => {
  const h = harness(t);
  await h.collector.collect();
  assert.equal(h.store.db.prepare("SELECT status FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get().status, 'unavailable');
});

test('a readable current Origin transcript remains healthy in single-session snapshots', async t => {
  const h = harness(t, {}, { sessionGroup: null });
  const filename = h.select('single-session', [turn({ model: 'current-model' })]);
  await h.collector.collect();
  assert.equal(h.snapshotCalls, 1);
  assert.equal(h.transcripts.snapshot.rows[0].sessionGroup, null);
  const health = h.store.db.prepare("SELECT status, extra FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get();
  assert.equal(health.status, 'healthy');
  assert.equal(JSON.parse(health.extra).transcript_path, filename);
});

test('a removed current transcript marks liveness unavailable while its mapping remains', async t => {
  const h = harness(t);
  const filename = h.select('removed-current', [turn({ model: 'current-model' })]);
  await h.collector.collect();
  assert.equal(h.store.db.prepare("SELECT status FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get().status, 'healthy');
  // Both production runtime collectors share an inventory round. A Claude
  // transcript keeps the missing-file update pending until that poller runs.
  const claudeFile = path.join(path.dirname(filename), 'claude-current.jsonl');
  fs.writeFileSync(claudeFile, '');
  h.store.insertUsageTranscript({ transcript_path: claudeFile, runtime: 'claude',
    session_id: 'claude-current', session_group: 'other-group', run_id: 'run-claude' }, new Date().toISOString());
  fs.unlinkSync(filename);
  assert.equal(h.store.currentOriginTranscript('codex', 'run-removed-current').transcript_path, filename);
  await h.collector.collect();
  assert.equal(h.store.currentOriginTranscript('codex', 'run-removed-current').transcript_path, filename);
  assert.equal(h.store.getUsageTranscript(filename).status, 'active');
  const health = h.store.db.prepare("SELECT status, extra FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get();
  assert.equal(health.status, 'unavailable');
  assert.equal(JSON.parse(health.extra).reason, 'rollout_unreadable');
  const claudeCollector = new ConversationCollector(h.store, {}, { transcripts: h.transcripts });
  await claudeCollector.collect();
  assert.equal(h.store.getUsageTranscript(filename).status, 'missing');
});

test('a failed snapshot refresh retains established collector liveness', async t => {
  const h = harness(t);
  h.select('snapshot-failure', [turn({ model: 'current-model' })]);
  await h.collector.collect();
  const readHealth = () => h.store.db.prepare("SELECT * FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get();
  const health = readHealth();
  assert.equal(health.status, 'healthy');
  assert.equal(h.snapshotCalls, 1);
  h.failSnapshot();
  await h.collector.collect();
  assert.equal(h.snapshotCalls, 2);
  assert.equal(h.transcripts.snapshot, null);
  assert.deepEqual(readHealth(), health);
});
