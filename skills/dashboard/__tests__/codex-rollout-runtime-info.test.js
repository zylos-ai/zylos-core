import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { codexRuntimeFields } from '../src/lib/runtime-info.js';
import { Store } from '../src/lib/store.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';

function harness(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-info-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const snapshot = { listKnown: true, rows: [{ sessionGroup: 'origin', live: { runId: null } }] };
  let clock = Date.now(), unavailable = false;
  const transcripts = new UsageTranscripts(store, { homeDir: dir, zylosDir: dir }, {
    now: () => clock, getSnapshot: async () => unavailable ? null : snapshot,
  });
  const collector = new CodexRolloutCollector(store, { ...config, zylosDir: dir }, { transcripts });
  const updates = [];
  collector._onRuntimeInfo = info => updates.push(info);
  return {
    collector, updates, store, transcripts,
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
    unavailable() { snapshot.rows[0].live.runId = null; },
    failSnapshot() { unavailable = true; clock += 60000; },
  };
}

const turn = payload => ({ type: 'turn_context', payload });

// SQLite/transcript integration with injected snapshots only. Run for collector
// metadata or inventory wiring changes; UI-only changes can skip. The isolated
// runner supplies HOME/ZYLOS_DIR/PM2_HOME/private short TMPDIR and tmux directory.
// This case owns its database/files and starts no services, processes or timers.
test('current turn evidence supplies effort and explicit tier without configuration defaults', async t => {
  const h = harness(t, { model: 'configured-model', model_reasoning_effort: 'high', service_tier: 'priority' });
  for (const tier of ['priority', 'standard', undefined, 'unrecognized']) {
    h.select(`session-${tier}`, [turn({ model: 'unknown-runtime-model', effort: 'medium', service_tier: tier })]);
    await h.collector.collect();
    const info = h.collector.getRuntimeInfo();
    assert.equal(info.model_id, 'unknown-runtime-model');
    assert.equal(info.reasoning_effort, 'medium');
    assert.equal(info.service_tier, ['standard', 'priority'].includes(tier) ? tier : null);
  }
  h.select('reasoning-alias', [turn({ model: 'model', reasoning_effort: 'low' })]);
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, 'low');
});

test('session changes and unavailable evidence clear all prior runtime facts', async t => {
  const h = harness(t);
  h.select('first', [
    { type: 'session_meta', payload: { cli_version: '1.0' } },
    turn({ model: 'old-model', effort: 'high', service_tier: 'priority' })
  ]);
  await h.collector.collect();
  h.select('empty', []);
  await h.collector.collect();
  let info = h.collector.getRuntimeInfo();
  assert.equal(info.session_id, 'empty');
  assert.equal(info.model_id, undefined);
  assert.equal(info.cli_version, undefined);
  assert.equal(info.reasoning_effort, null);
  assert.equal(info.service_tier, null);
  h.select('new', [turn({ model: 'new-model', effort: 'low' })]);
  await h.collector.collect();
  h.unavailable();
  await h.collector.collect();
  info = h.collector.getRuntimeInfo();
  assert.equal(info.session_id, null);
  assert.equal(info.model_id, undefined);
  assert.equal(info.reasoning_effort, null);
  assert.equal(info.service_tier, null);
  const filename = h.select('unreadable', [turn({ model: 'stale-model' })]);
  await h.collector.collect();
  fs.unlinkSync(filename);
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
});

test('bounded replay never publishes historical turn context over latest evidence', async t => {
  const h = harness(t, { codexRolloutMaxLinesPerCollect: 1 });
  h.select('bounded', [
    turn({ model: 'older', effort: 'high', service_tier: 'priority' }),
    turn({ model: 'latest' })
  ]);
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'latest');
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, null);
  assert.equal(h.collector.getRuntimeInfo().service_tier, null);
  await h.collector.collect();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].model_id, 'latest');
});

test('replaced transcript cannot reuse cached model facts after truncation', async t => {
  const h = harness(t);
  h.select('replaced', [turn({ model: 'old', effort: 'high' })]);
  await h.collector.collect();
  h.select('replaced', [turn({})]);
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, null);
});

test('same-size transcript replacement invalidates runtime metadata', async t => {
  const h = harness(t);
  const filename = h.select('same-size', [turn({ model: 'old' })]);
  await h.collector.collect();
  const replacement = `${filename}.replacement`;
  fs.writeFileSync(replacement, JSON.stringify(turn({ model: 'new' })) + '\n');
  fs.renameSync(replacement, filename);
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'new');
});

test('collector evidence reaches runtime fields independently of configured values', async t => {
  const h = harness(t);
  const configured = { model: 'configured-model', effort: 'high' };
  h.select('actual', [turn({ model: 'actual-model', effort: 'medium', service_tier: 'priority' })]);
  await h.collector.collect();
  assert.deepEqual(codexRuntimeFields(h.collector.getRuntimeInfo(), configured), {
    model: 'actual-model', model_id: 'actual-model', effort: 'medium', service_tier: 'priority',
    configured_model: 'configured-model', configured_effort: 'high'
  });
  h.select('no-evidence', []);
  await h.collector.collect();
  assert.deepEqual(codexRuntimeFields(h.collector.getRuntimeInfo(), configured), {
    model: null, model_id: null, effort: null, service_tier: null,
    configured_model: 'configured-model', configured_effort: 'high'
  });
});

test('new mapping clears runtime facts before the next collection poll', async t => {
  const h = harness(t);
  h.select('first', [turn({ model: 'old', effort: 'high', service_tier: 'priority' })]);
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'old');
  const nextPath = h.select('next', [turn({ model: 'next', effort: 'low' })]);
  assert.deepEqual(codexRuntimeFields(h.collector.getRuntimeInfo()), {
    model: null, model_id: null, effort: null, service_tier: null,
    configured_model: null, configured_effort: null
  });
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'next');
  h.map('next', `${nextPath}.different.jsonl`);
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, null);
  h.unavailable();
  assert.equal(h.collector.getRuntimeInfo().session_id, null);
});

test('same-run replacement publishes only the newest discovered Origin file', async t => {
  const h = harness(t);
  const previous = h.select('same-run', [turn({ model: 'old-model' })]);
  await h.collector.collect();
  const replacement = path.join(path.dirname(previous), 'aaa-replacement.jsonl');
  fs.writeFileSync(replacement, JSON.stringify(turn({ model: 'new-model' })) + '\n');
  h.map('same-run', replacement);
  h.store.updateUsageTranscript(previous, { now: h.store.getUsageTranscript(replacement).updated_at });
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
  const visited = [];
  const collectMapping = h.collector.collectMapping.bind(h.collector);
  t.mock.method(h.collector, 'collectMapping', mapping => {
    visited.push([mapping.transcript_path, mapping.isOriginCurrent]);
    return collectMapping(mapping);
  });
  await h.collector.collect();
  assert.equal(visited[0][0], replacement);
  assert.equal(visited.find(([file]) => file === previous)[1], false);
  assert.equal(h.collector.getRuntimeInfo().model_id, 'new-model');
  const health = h.store.db.prepare("SELECT status, extra FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get();
  assert.equal(health.status, 'healthy');
  assert.equal(JSON.parse(health.extra).transcript_path, replacement);
});

test('a complete snapshot without a current Origin mapping clears facts on the first poll', async t => {
  const h = harness(t);
  await h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().session_id, null);
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
  assert.equal(h.store.db.prepare("SELECT status FROM source_health WHERE name='codex_rollout' AND signal_type='collector_liveness'").get().status, 'unavailable');
});
