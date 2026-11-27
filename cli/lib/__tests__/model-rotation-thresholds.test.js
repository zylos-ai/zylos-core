import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelThreshold, loadRuntimeContexts, migrateModelThresholds, setModelThreshold } from '../model-rotation-thresholds.js';

const contexts = await loadRuntimeContexts();

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
  assert.equal(modelThreshold(config, { runtime: 'claude', context: contexts.claude, model: 'claude-sonnet-4-6', contextWindow: 200000,
    launchConfig: { runtime: 'claude', mode: 'override', model: 'sonnet' } }), 65);
  assert.equal(modelThreshold(config, { runtime: 'claude', context: contexts.claude, model: 'claude-opus-4-6', contextWindow: 1000000,
    defaultModel: 'opus[1m]', launchConfig: { runtime: 'claude', mode: 'default' } }), 35);
  assert.equal(modelThreshold(config, { runtime: 'claude', context: contexts.claude, model: 'haiku' }), 75);
  assert.equal(modelThreshold(config, { runtime: 'claude', context: contexts.claude, model: 'haiku[1m]' }), 20);
  assert.equal(modelThreshold(config, { runtime: 'codex', context: contexts.codex, model: 'model-a', contextWindow: 200000 }), 61);
});

test('a threshold set for the launch model applies when the session runs at a larger window', () => {
  const config = { model_rotation_thresholds: { claude: { opus: 40 } } };
  const session = { runtime: 'claude', context: contexts.claude, model: 'claude-opus-5-5', contextWindow: 1000000 };
  assert.equal(modelThreshold(config, { ...session, defaultModel: 'opus', launchConfig: { runtime: 'claude', mode: 'default' } }), 40);
  assert.equal(modelThreshold(config, { ...session, launchConfig: { runtime: 'claude', mode: 'override', model: 'opus' } }), 40);
  assert.equal(modelThreshold(config, session), 20, 'without launch evidence the observed window decides');
});

test('migration leaves absent or invalid legacy thresholds implicit instead of storing policy defaults', async t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'opus[1m]' });
  f.write('.codex/config.toml', 'model = "small"\n');
  for (const value of [undefined, null, 'not-a-number', 0, 101]) {
    f.write('.zylos/config.json', { keep: true, new_session_threshold: value });
    const before = fs.readFileSync(f.file, 'utf8');
    const result = await migrateModelThresholds({ zylosDir: f.root, updateConfig: () => assert.fail('no legacy value needs a config write') });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal(Object.hasOwn(f.read(), 'model_rotation_thresholds'), false);
    assert.equal(modelThreshold(f.read(), { runtime: 'claude', context: contexts.claude, model: 'opus[1m]' }), 20);
  }
  f.write('.zylos/config.json', { new_session_threshold: 64 });
  assert.equal((await migrateModelThresholds({ zylosDir: f.root })).changed, true);
  assert.deepEqual(f.read().model_rotation_thresholds, { claude: { 'opus[1m]': 64 } });
});

test('migrates legacy values once without losing raw values', async t => {
  const f = fixture(t);
  f.write('.zylos/config.json', { new_session_threshold: 83, codex_new_session_threshold: 75, unknown: false });
  f.write('.claude/settings.json', { model: 'opus[1m]' });
  f.write('.codex/config.toml', 'model = "small"\n');
  assert.equal((await migrateModelThresholds({ zylosDir: f.root })).changed, true);
  const first = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.read().model_rotation_thresholds.claude['opus[1m]'], 83);
  assert.equal(f.read().model_rotation_thresholds.codex.small, 75);
  assert.equal(modelThreshold(f.read(), { runtime: 'claude', context: contexts.claude, model: 'opus[1m]' }), 83);
  assert.equal(modelThreshold(f.read(), { runtime: 'claude', context: contexts.claude, model: 'claude-opus-4-6', contextWindow: 1000000 }), 20);
  assert.equal((await migrateModelThresholds({ zylosDir: f.root })).changed, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), first);
  f.write('.claude/settings.json', { model: 'sonnet' });
  assert.equal((await migrateModelThresholds({ zylosDir: f.root })).changed, false);
  assert.equal(modelThreshold(f.read(), { runtime: 'claude', context: contexts.claude, model: 'sonnet', defaultModel: 'sonnet' }), 75);
});

test('one model update preserves sibling models and engine values', async t => {
  const f = fixture(t);
  f.write('.zylos/config.json', { model_rotation_thresholds: { claude: { sonnet: 61, 'opus[1m]': 34 }, codex: { small: 73 } } });
  await setModelThreshold({ zylosDir: f.root, runtime: 'claude', model: 'sonnet', value: 67 });
  assert.deepEqual(f.read().model_rotation_thresholds, { claude: { sonnet: 67, 'opus[1m]': 34 }, codex: { small: 73 } });
  await assert.rejects(setModelThreshold({ zylosDir: f.root, runtime: 'claude', model: 'opus[1m]', value: 96 }), error => error.code === 'INVALID_MODEL_THRESHOLD');
  await assert.rejects(setModelThreshold({ zylosDir: f.root, runtime: 'codex', model: 'large', value: 96, modelWindows: { codex: [{ slug: 'large', context_window: 1000000 }] } }), error => error.code === 'INVALID_MODEL_THRESHOLD');
  await assert.rejects(setModelThreshold({ zylosDir: f.root, runtime: 'claude', model: 'sonnet', value: 96 }), error => error.code === 'INVALID_MODEL_THRESHOLD');
});
