import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { codexRuntimeFields } from '../src/lib/runtime-info.js';

function harness(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-info-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let mapping;
  const cursors = new Map();
  const store = {
    latestCodexRolloutPath: () => mapping,
    getCodexRolloutCursor: filename => cursors.get(filename),
    upsertCodexRolloutCursor: cursor => cursors.set(cursor.transcriptPath, { byte_offset: cursor.byteOffset }),
    upsertSourceHealth() {}
  };
  const collector = new CodexRolloutCollector(store, config);
  const updates = [];
  collector._onRuntimeInfo = info => updates.push(info);
  return {
    collector, updates,
    select(session, events) {
      const filename = path.join(dir, `${session}.jsonl`);
      fs.writeFileSync(filename, events.map(event => JSON.stringify(event) + '\n').join(''));
      mapping = { session_id: session, transcript_path: filename };
      return filename;
    },
    map(session, filename) { mapping = { session_id: session, transcript_path: filename }; },
    unavailable() { mapping = null; }
  };
}

const turn = payload => ({ type: 'turn_context', payload });

test('current turn evidence supplies effort and explicit tier without configuration defaults', t => {
  const h = harness(t, { model: 'configured-model', model_reasoning_effort: 'high', service_tier: 'priority' });
  for (const tier of ['priority', 'standard', undefined, 'unrecognized']) {
    h.select(`session-${tier}`, [turn({ model: 'unknown-runtime-model', effort: 'medium', service_tier: tier })]);
    h.collector.collect();
    const info = h.collector.getRuntimeInfo();
    assert.equal(info.model_id, 'unknown-runtime-model');
    assert.equal(info.reasoning_effort, 'medium');
    assert.equal(info.service_tier, ['standard', 'priority'].includes(tier) ? tier : null);
  }
  h.select('reasoning-alias', [turn({ model: 'model', reasoning_effort: 'low' })]);
  h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, 'low');
});

test('session changes and unavailable evidence clear all prior runtime facts', t => {
  const h = harness(t);
  h.select('first', [
    { type: 'session_meta', payload: { cli_version: '1.0' } },
    turn({ model: 'old-model', effort: 'high', service_tier: 'priority' })
  ]);
  h.collector.collect();
  h.select('empty', []);
  h.collector.collect();
  let info = h.collector.getRuntimeInfo();
  assert.equal(info.session_id, 'empty');
  assert.equal(info.model_id, undefined);
  assert.equal(info.cli_version, undefined);
  assert.equal(info.reasoning_effort, null);
  assert.equal(info.service_tier, null);
  h.select('new', [turn({ model: 'new-model', effort: 'low' })]);
  h.collector.collect();
  h.unavailable();
  h.collector.collect();
  info = h.collector.getRuntimeInfo();
  assert.equal(info.session_id, null);
  assert.equal(info.model_id, undefined);
  assert.equal(info.reasoning_effort, null);
  assert.equal(info.service_tier, null);
  const filename = h.select('unreadable', [turn({ model: 'stale-model' })]);
  h.collector.collect();
  fs.unlinkSync(filename);
  h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
});

test('bounded replay never publishes historical turn context over latest evidence', t => {
  const h = harness(t, { codexRolloutMaxLinesPerCollect: 1 });
  h.select('bounded', [
    turn({ model: 'older', effort: 'high', service_tier: 'priority' }),
    turn({ model: 'latest' })
  ]);
  h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'latest');
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, null);
  assert.equal(h.collector.getRuntimeInfo().service_tier, null);
  h.collector.collect();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].model_id, 'latest');
});

test('replaced transcript cannot reuse cached model facts after truncation', t => {
  const h = harness(t);
  h.select('replaced', [turn({ model: 'old', effort: 'high' })]);
  h.collector.collect();
  h.select('replaced', [turn({})]);
  h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, null);
});

test('same-size transcript replacement invalidates runtime metadata', t => {
  const h = harness(t);
  const filename = h.select('same-size', [turn({ model: 'old' })]);
  h.collector.collect();
  const replacement = `${filename}.replacement`;
  fs.writeFileSync(replacement, JSON.stringify(turn({ model: 'new' })) + '\n');
  fs.renameSync(replacement, filename);
  h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'new');
});

test('collector evidence reaches runtime fields independently of configured values', t => {
  const h = harness(t);
  const configured = { model: 'configured-model', effort: 'high' };
  h.select('actual', [turn({ model: 'actual-model', effort: 'medium', service_tier: 'priority' })]);
  h.collector.collect();
  assert.deepEqual(codexRuntimeFields(h.collector.getRuntimeInfo(), configured), {
    model: 'actual-model', model_id: 'actual-model', effort: 'medium', service_tier: 'priority',
    configured_model: 'configured-model', configured_effort: 'high'
  });
  h.select('no-evidence', []);
  h.collector.collect();
  assert.deepEqual(codexRuntimeFields(h.collector.getRuntimeInfo(), configured), {
    model: null, model_id: null, effort: null, service_tier: null,
    configured_model: 'configured-model', configured_effort: 'high'
  });
});

test('new mapping clears runtime facts before the next collection poll', t => {
  const h = harness(t);
  h.select('first', [turn({ model: 'old', effort: 'high', service_tier: 'priority' })]);
  h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'old');
  const nextPath = h.select('next', [turn({ model: 'next', effort: 'low' })]);
  assert.deepEqual(codexRuntimeFields(h.collector.getRuntimeInfo()), {
    model: null, model_id: null, effort: null, service_tier: null,
    configured_model: null, configured_effort: null
  });
  h.collector.collect();
  assert.equal(h.collector.getRuntimeInfo().model_id, 'next');
  h.map('next', `${nextPath}.different`);
  assert.equal(h.collector.getRuntimeInfo().model_id, undefined);
  assert.equal(h.collector.getRuntimeInfo().reasoning_effort, null);
  h.unavailable();
  assert.equal(h.collector.getRuntimeInfo().session_id, null);
});
