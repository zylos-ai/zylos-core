import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getRuntime } from '../index.js';
import { groupRunDir } from '../../session-group-paths.js';
import { publishContextSample } from '../../../../skills/activity-monitor/scripts/context-monitor.js';

function fixture(t, id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root, ZYLOS_RUN_ID: 'recorded-sample', ZYLOS_MODEL_CONFIG: JSON.stringify({ runtime: id }) };
  return { dir: groupRunDir('origin', env), env };
}

function recorded(file) {
  return fs.readFileSync(new URL(`samples/${file}`, import.meta.url), 'utf8');
}

test('Claude publishes native statusLine fields and reads its context sample', async t => {
  const { context } = await getRuntime('claude');
  const { dir, env } = fixture(t, 'claude');
  const raw = recorded('claude/context/statusline.json');
  const native = JSON.parse(raw);
  assert.deepEqual(context.statusLine.normalize(native), native);
  assert.equal(Object.hasOwn(native, 'contextUsage'), false);

  const capturedAt = 1_795_248_216_000;
  const published = await publishContextSample(raw, { env, now: capturedAt });
  const sample = context.readUsageSample({ dir });
  assert.equal(sample.error, null);
  assert.equal(sample.sampledAt, capturedAt);
  assert.deepEqual(sample.value, published);
  const facts = context.usageFacts(sample.value);
  assert.equal(facts.model, 'claude-sonnet-4-6');
  assert.equal(facts.contextWindow, 200_000);
  assert.ok(Number.isFinite(facts.usedPercent) && facts.usedPercent >= 0 && facts.usedPercent <= 100);
  assert.equal(facts.usedPercent, native.context_window.used_percentage);
  assert.equal(facts.usedTokens, null);
  assert.equal(facts.version, '2.1.179');
});

test('Antigravity publishes the native conversation identity and reads its context sample', async t => {
  const { context } = await getRuntime('agy');
  const { dir, env } = fixture(t, 'agy');
  // Reviewer-recorded Antigravity CLI 1.5.13 sample, with provenance in busy/manifest.json.
  const raw = recorded('agy/busy/idle.json');
  const native = JSON.parse(raw);
  assert.equal(typeof native.model, 'object');
  assert.equal(typeof native.model.id, 'string');
  assert.ok(native.transcript_path);

  const published = await publishContextSample(raw, { env });
  assert.equal(published.session_id, native.conversation_id);
  assert.equal(Object.hasOwn(published, 'transcript_path'), false);
  const sample = context.readUsageSample({ dir });
  assert.equal(sample.error, null);
  assert.deepEqual(sample.value, published);
  assert.deepEqual(context.usageFacts(sample.value), {
    model: native.model.id,
    contextWindow: 1_048_576,
    usedPercent: native.context_window.used_percentage,
    usedTokens: null,
    effort: native.model.effort,
    version: native.version,
  });
  assert.ok(Number.isFinite(native.context_window.used_percentage));
});

test('Codex reads context from a recorded rollout bound to its Zylos session start', async t => {
  const { context } = await getRuntime('codex');
  const { dir, env } = fixture(t, 'codex');
  const start = JSON.parse(recorded('codex/context/session-start.jsonl'));
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(transcriptPath, recorded('codex/context/rollout.jsonl'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ...start, transcript_path: transcriptPath }) + '\n');
  const identity = { present: true, ready: true, runtime: 'codex', runId: start.run_id, sessionId: start.session_id };
  const sample = context.readUsageSample({ dir, env, identity, sessionGroup: start.session_group });
  assert.equal(sample.error, undefined);
  assert.deepEqual(sample.identity, { runId: identity.runId, sessionId: identity.sessionId });
  assert.deepEqual(sample.value.contextUsage, { used: 450, ceiling: 258_400 });
  assert.deepEqual(context.usageFacts(sample.value), {
    model: 'gpt-5.4-mini', contextWindow: 258_400, usedPercent: null, usedTokens: 450, effort: null, version: null,
  });
});

test('Codex resolves the model window from its recorded cache', async t => {
  const { context } = await getRuntime('codex');
  const { env } = fixture(t, 'codex');
  const codexHome = path.join(env.ZYLOS_DIR, '.codex');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), recorded('codex/context/models_cache.json'));
  const windows = context.readModelWindows({ env: { CODEX_HOME: codexHome } });
  assert.ok(windows.length > 0);
  for (const model of windows) {
    assert.ok(model.context_window > 0);
    assert.equal(context.contextWindowFor(model.slug, windows), model.context_window);
  }
});
