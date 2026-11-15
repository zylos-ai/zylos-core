import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { Store } from '../src/lib/store.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';

function harness(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-liveness-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const snapshot = { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: null } }] };
  let clock = Date.now();
  const transcripts = new UsageTranscripts(store, { homeDir: dir, zylosDir: dir }, {
    now: () => clock, getSnapshot: async () => snapshot,
  });
  const collector = new CodexRolloutCollector(store, { ...config, zylosDir: dir }, { transcripts });
  return {
    collector, store, transcripts,
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
