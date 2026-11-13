import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-sonnet-4-6', contextWindow: 200000,
    launchConfig: { runtime: 'claude', mode: 'override', model: 'sonnet' } }), 65);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 1000000,
    defaultModel: 'opus[1m]', launchConfig: { runtime: 'claude', mode: 'default' } }), 35);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'haiku' }), 70);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'haiku[1m]' }), 40);
  assert.equal(modelThreshold(config, { runtime: 'codex', model: 'model-a', contextWindow: 200000 }), 61);
});

test('keeps exact Claude versions and observed context classes separate from family aliases', () => {
  const config = { model_rotation_thresholds: { claude: { opus: 60, 'opus[1m]': 37, 'claude-opus-4-6': 63, 'claude-opus-4-6[1m]': 32 } } };
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 200000 }), 63);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 1000000 }), 32);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-7', contextWindow: 200000 }), 70);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-7', contextWindow: 1000000 }), 40);
  assert.equal(modelThresholdKey({ runtime: 'claude', model: 'claude-opus-4-6', contextWindow: 1000000 }), 'claude-opus-4-6[1m]');
});

test('Claude version IDs use alias thresholds only when launched through that same alias', () => {
  const config = { model_rotation_thresholds: { claude: { opus: 60, 'opus[1m]': 30, sonnet: 55 } } };
  const large = { runtime: 'claude', model: 'claude-opus-5-5', contextWindow: 1000000, defaultModel: 'opus[1m]' };
  assert.equal(modelThreshold(config, { ...large, launchConfig: { runtime: 'claude', mode: 'default' } }), 30);
  assert.equal(modelThreshold(config, { ...large, launchConfig: { runtime: 'claude', mode: 'override', model: 'opus[1m]' } }), 30);
  assert.equal(modelThreshold(config, { ...large, model: 'claude-opus-4-6[1m]',
    launchConfig: { runtime: 'claude', mode: 'override', model: 'claude-opus-4-6[1m]' } }), 40);
  assert.equal(modelThreshold(config, large), 40, 'a model preview has no evidence that the session used an alias');
  assert.equal(modelThreshold(config, { ...large, defaultModel: 'opus', launchConfig: { runtime: 'claude', mode: 'default' } }), 40);
  assert.equal(modelThreshold(config, { ...large, launchConfig: { runtime: 'claude', mode: 'override', model: 'opus' } }), 40);
  assert.equal(modelThreshold(config, { ...large, launchConfig: { runtime: 'claude', mode: 'override', model: 'sonnet[1m]' } }), 40);
  assert.equal(modelThreshold(config, { ...large, launchConfig: { runtime: 'codex', mode: 'override', model: 'opus[1m]' } }), 40);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-7', contextWindow: 200000,
    launchConfig: { runtime: 'claude', mode: 'override', model: 'opus' } }), 60);
  assert.equal(modelThreshold({ model_rotation_thresholds: { claude: { 'opus[1m]': 30, 'claude-opus-5-5[1m]': 35 } } },
    { ...large, launchConfig: { runtime: 'claude', mode: 'default' } }), 35, 'an exact version key still precedes its launch alias');
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
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', defaultModel: 'opus',
    launchConfig: { runtime: 'claude', mode: 'default' } }), 66);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', defaultModel: 'opus' }), 70);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', defaultModel: 'opus',
    launchConfig: { runtime: 'claude', mode: 'override', model: 'claude-opus-4-6' } }), 70);
  assert.equal(modelThreshold(config, { runtime: 'claude', model: 'claude-opus-4-6', defaultModel: 'opus',
    launchConfig: { runtime: 'claude', mode: 'override', model: 'opus' } }), 66);
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
  f.write('.codex/config.toml', '[provider]\nmodel = "nested-only-model"\n');
  assert.equal(readDefaultModels({ zylosDir: f.root }).codex, null, 'a table-only model is not a root default');
});

test('legacy scalar parsing preserves accepted historical numeric prefixes while model writes stay strict', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'opus' });
  for (const [stored, expected] of [['45%', 45], ['50abc', 50], [30.5, 30], ['100tail', 100]]) {
    const config = { new_session_threshold: stored };
    assert.equal(modelThreshold(config, { runtime: 'claude', model: 'opus', defaultModel: 'opus' }), expected);
    f.write('.zylos/config.json', config);
    assert.equal(migrateModelThresholds({ zylosDir: f.root }).changed, true);
    assert.equal(f.read().model_rotation_thresholds.claude.opus, expected);
    assert.equal(f.read().new_session_threshold, stored, 'the historical scalar bytes remain represented by their original value');
  }
  assert.equal(modelThreshold({ model_rotation_thresholds: { claude: { opus: '45%' } } }, { runtime: 'claude', model: 'opus' }), 70);
  for (const value of ['45%', '50abc', 30.5]) {
    assert.throws(() => setModelThreshold({ zylosDir: f.root, runtime: 'claude', model: 'opus', value }), error => error.code === 'INVALID_MODEL_THRESHOLD');
  }
});

test('migration leaves absent or invalid legacy thresholds implicit instead of storing policy defaults', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'opus[1m]' });
  f.write('.codex/config.toml', 'model = "small"\n');
  for (const value of [undefined, null, 'not-a-number', 0, 101]) {
    f.write('.zylos/config.json', { keep: true, new_session_threshold: value });
    const before = fs.readFileSync(f.file, 'utf8');
    const result = migrateModelThresholds({ zylosDir: f.root, updateConfig: () => assert.fail('no legacy value needs a config write') });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal(Object.hasOwn(f.read(), 'model_rotation_thresholds'), false);
    assert.equal(modelThreshold(f.read(), { runtime: 'claude', model: 'opus[1m]' }), 40);
  }
  f.write('.zylos/config.json', { new_session_threshold: 64 });
  assert.equal(migrateModelThresholds({ zylosDir: f.root }).changed, true);
  assert.deepEqual(f.read().model_rotation_thresholds, { claude: { 'opus[1m]': 64 } });
});

for (const [key, runtime, model, value] of [
  ['new_session_threshold', 'claude', 'opus', 60],
  ['codex_new_session_threshold', 'codex', 'private-codex', 55],
]) test(`legacy CLI key ${key} updates only its own engine native model`, t => {
  const f = fixture(t);
  f.write('.zylos/config.json', { runtime: 'claude', model_rotation_thresholds: { claude: { opus: 66 }, codex: { 'private-codex': 73 } } });
  f.write('.claude/settings.json', { model: 'opus' });
  f.write('.codex/config.toml', 'model = "private-codex"\n');
  const cli = fileURLToPath(new URL('../../zylos.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'config', 'set', key, String(value)], {
    env: { ...process.env, HOME: f.root, ZYLOS_DIR: f.root, CODEX_HOME: path.join(f.root, '.codex') },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const expected = { claude: { opus: 66 }, codex: { 'private-codex': 73 } };
  expected[runtime][model] = value;
  assert.deepEqual(f.read().model_rotation_thresholds, expected);
  assert.equal(Object.hasOwn(f.read(), key), false, 'the CLI does not resume scalar writes');
  const saved = fs.readFileSync(f.file, 'utf8');
  const belowMinimum = spawnSync(process.execPath, [cli, 'config', 'set', key, '9'], {
    env: { ...process.env, HOME: f.root, ZYLOS_DIR: f.root, CODEX_HOME: path.join(f.root, '.codex') },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(belowMinimum.status, 1, belowMinimum.stderr);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved, 'rejected old-key writes preserve all model settings');
});

test('new model thresholds require at least ten while old low thresholds remain valid and migrate unchanged', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'opus' });
  f.write('.zylos/config.json', { new_session_threshold: '5%' });
  assert.equal(modelThreshold(f.read(), { runtime: 'claude', model: 'opus', defaultModel: 'opus' }), 5);
  migrateModelThresholds({ zylosDir: f.root });
  assert.equal(f.read().model_rotation_thresholds.claude.opus, 5);
  assert.equal(f.read().new_session_threshold, '5%');
  assert.equal(modelThreshold(f.read(), { runtime: 'claude', model: 'opus' }), 5);
  const saved = fs.readFileSync(f.file, 'utf8');
  for (const model of ['opus', 'opus[1m]']) for (const value of [1, 9, '9']) {
    assert.throws(() => setModelThreshold({ zylosDir: f.root, runtime: 'claude', model, value }),
      error => error.code === 'INVALID_MODEL_THRESHOLD' && /from 10 to/.test(error.message));
  }
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
  for (const [model, value] of [['opus', 10], ['opus', 95], ['opus[1m]', 10], ['opus[1m]', 40]]) {
    setModelThreshold({ zylosDir: f.root, runtime: 'claude', model, value });
    assert.equal(f.read().model_rotation_thresholds.claude[model], value);
  }
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

test('Codex model cache is parsed again only after the file changes', t => {
  const f = fixture(t);
  const codexHome = path.join(f.root, 'codex'), file = path.join(codexHome, 'models_cache.json');
  const read = () => readCodexModelWindows({ codexHome });
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (target, ...rest) { if (target === file) reads++; return original.call(this, target, ...rest); };
  t.after(() => { fs.readFileSync = original; });
  const windows = value => ({ models: [{ slug: 'model-a', context_window: value }] });

  f.write('codex/models_cache.json', windows(200000));
  assert.equal(read()[0].context_window, 200000);
  for (let i = 0; i < 3; i++) assert.equal(read()[0].context_window, 200000);
  assert.equal(reads, 1, 'an unchanged file is not read again');

  // Atomic replacement, as an updater writes it.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(windows(400000)));
  fs.renameSync(`${file}.tmp`, file);
  assert.equal(read()[0].context_window, 400000);
  // In-place rewrite.
  fs.writeFileSync(file, JSON.stringify(windows(1000000)));
  assert.equal(read()[0].context_window, 1000000);
  assert.equal(read()[0].context_window, 1000000);
  assert.equal(reads, 3);

  fs.writeFileSync(file, '{"models": [');
  assert.deepEqual(read(), [], 'an unparseable cache still reads as no models');
  fs.rmSync(file);
  assert.deepEqual(read(), []);
  f.write('codex/models_cache.json', windows(272000));
  assert.equal(read()[0].context_window, 272000);
});

test('Codex model cache recovers after a transient read failure without a file change', t => {
  const f = fixture(t), codexHome = path.join(f.root, 'codex');
  const file = path.join(codexHome, 'models_cache.json');
  f.write('codex/models_cache.json', { models: [{ slug:'model-a', context_window:272000 }] });
  const signature = fs.statSync(file), original = fs.readFileSync;
  let fail = true, reads = 0;
  t.mock.method(fs, 'readFileSync', function(target, ...args) {
    if (target === file) {
      reads++;
      if (fail) { fail = false; throw Object.assign(new Error('temporary descriptor exhaustion'), {code:'EMFILE'}); }
    }
    return original.call(this, target, ...args);
  });
  assert.deepEqual(readCodexModelWindows({codexHome}), []);
  assert.equal(readCodexModelWindows({codexHome})[0].context_window, 272000);
  assert.equal(readCodexModelWindows({codexHome})[0].context_window, 272000);
  assert.equal(reads, 2, 'successful recovery is cached');
  assert.equal(fs.statSync(file).mtimeMs, signature.mtimeMs);
  assert.equal(fs.statSync(file).ctimeMs, signature.ctimeMs);
});
