import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelThreshold, modelThresholdKey, thresholdLimit, readDefaultModels, readCodexModelWindows, migrateModelThresholds, setModelThreshold } from '../model-rotation-thresholds.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-threshold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.zylos/config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (relative, value) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { root, file, write, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('uses distinct model values and defaults for actual context windows', () => {
  const config = { model_rotation_thresholds: { claude: { sonnet: 65, 'opus[1m]': 35 }, codex: { 'model-a': 61 } } };
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-sonnet-4-6', contextWindow: 200000 }), 65);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 1000000 }), 35);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'haiku' }), 70);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'haiku[1m]' }), 40);
  assert.equal(modelThreshold(config, { runtime: 'codex', model: 'model-a', contextWindow: 200000 }), 61);
});

test('keeps exact Claude versions and observed context classes separate from family aliases', () => {
  const config = { model_rotation_thresholds: { claude: { opus: 60, 'opus[1m]': 37, 'claude-opus-4-6': 63, 'claude-opus-4-6[1m]': 32 } } };
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 200000 }), 63);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 1000000 }), 32);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-7', contextWindow: 200000 }), 60);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-7', contextWindow: 1000000 }), 37);
  assert.equal(modelThresholdKey({ runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 1000000 }), 'claude-opus-4-6[1m]');
});

test('uses only matching Codex cache windows and recognizes raw one million at effective 950K', () => {
  const codexModels = [{ slug: 'large', context_window: 1000000, effective_context_window_percent: 95 }, { slug: 'small', context_window: 272000 }];
  assert.equal(modelThreshold({}, { runtime: 'codex', model: 'large', contextWindow: 950000, codexModels }), 40);
  assert.equal(thresholdLimit({ runtime: 'codex', model: 'large', codexModels }), 40);
  assert.equal(modelThreshold({}, { runtime: 'codex', model: 'small', codexModels }), 70);
  assert.equal(modelThreshold({}, { runtime: 'codex', model: 'unknown', codexModels }), 70);
});

test('legacy fallback is limited to a matching default and stops after model migration', () => {
  const config = { new_session_threshold: 66, codex_new_session_threshold: 75 };
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', defaultModel: 'opus' }), 66);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', defaultModel: 'opus[1m]', contextWindow: 200000 }), 70);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', defaultModel: 'claude-opus-4-7' }), 70);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: null, defaultModel: 'opus' }), 70);
  assert.equal(modelThreshold({ ...config, model_rotation_thresholds: { claude: { opus: 66 } } }, { runtime: 'claude', model: 'sonnet', defaultModel: 'sonnet' }), 70);
  assert.equal(modelThreshold({ new_session_threshold: 100 }, { runtime: 'claude', model: 'opus', defaultModel: 'opus' }), 100);
});

test('native defaults ignore nested TOML models and public cache reader honors private paths', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'opus[1m]' });
  f.write('.codex/config.toml', 'model = "private-model"\n[provider]\nmodel = "other"\n');
  f.write('codex/models_cache.json', { models: [{ slug: 'private-model', context_window: 500000 }] });
  assert.deepEqual(readDefaultModels({ zylosDir: f.root }), { claude: 'opus[1m]', codex: 'private-model' });
  assert.equal(readCodexModelWindows({ codexHome: path.join(f.root, 'codex') })[0].context_window, 500000);
});

test('migrates legacy values once without losing raw values and caps only effective 1M usage', t => {
  const f = fixture(t);
  f.write('.zylos/config.json', { new_session_threshold: 83, codex_new_session_threshold: 75, unknown: false });
  f.write('.claude/settings.json', { model: 'opus[1m]' });
  f.write('.codex/config.toml', 'model = "small"\n');
  assert.equal(migrateModelThresholds({ zylosDir: f.root, codexModels: [] }).changed, true);
  const first = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.read().model_rotation_thresholds.claude['opus[1m]'], 83);
  assert.equal(f.read().model_rotation_thresholds.codex.small, 75);
  assert.equal(modelThreshold(f.read(), { runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 1000000 }), 40);
  assert.equal(migrateModelThresholds({ zylosDir: f.root, codexModels: [] }).changed, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), first);
  f.write('.claude/settings.json', { model: 'sonnet' });
  assert.equal(migrateModelThresholds({ zylosDir: f.root, codexModels: [] }).changed, false);
  assert.equal(modelThreshold(f.read(), { runtime: 'claude', model: 'sonnet', defaultModel: 'sonnet' }), 70);
});

test('one model update preserves sibling models and engine values with a single 1M cap', t => {
  const f = fixture(t);
  f.write('.zylos/config.json', { model_rotation_thresholds: { claude: { sonnet: 61, 'opus[1m]': 34 }, codex: { small: 73 } } });
  setModelThreshold({ zylosDir: f.root, runtime: 'claude', model: 'sonnet', value: 67, codexModels: [] });
  assert.deepEqual(f.read().model_rotation_thresholds, { claude: { sonnet: 67, 'opus[1m]': 34 }, codex: { small: 73 } });
  assert.throws(() => setModelThreshold({ zylosDir: f.root, runtime: 'claude', model: 'opus[1m]', value: 41 }), error => error.code === 'INVALID_MODEL_THRESHOLD');
  assert.throws(() => setModelThreshold({ zylosDir: f.root, runtime: 'codex', model: 'large', value: 41, codexModels: [{ slug: 'large', context_window: 1000000 }] }), error => error.code === 'INVALID_MODEL_THRESHOLD');
  assert.throws(() => setModelThreshold({ zylosDir: f.root, runtime: 'claude', model: 'sonnet', value: 96 }), error => error.code === 'INVALID_MODEL_THRESHOLD');
});


test('concurrent first model writes pin the legacy default and preserve both new model leaves', async t => {
  const f = fixture(t);
  f.write('.zylos/config.json', { new_session_threshold: 66, keep: true });
  f.write('.claude/settings.json', { model: 'opus' });
  const children = ['sonnet', 'haiku'].map((model, index) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/model-threshold-worker.js', import.meta.url)), f.root, model, String(61 + index)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stderr }));
    });
    return { child, closed };
  });
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map(item => item.closed));
  });
  for (const { closed } of children) {
    const result = await closed;
    assert.equal(result.code, 0, result.stderr);
  }
  assert.deepEqual(f.read(), { new_session_threshold: 66, keep: true, model_rotation_thresholds: { claude: { opus: 66, sonnet: 61, haiku: 62 } } });
});
