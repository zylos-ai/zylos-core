import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getActionsMeta, handleAction } from '../src/lib/actions.js';

async function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-actions-'));
  process.env.CODEX_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeZylosDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-zylos-'));
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  return dir;
}

test('getActionsMeta exposes model and effort controls for Codex runtime', () => withCodexHome((codexHome) => {
  const zylosDir = makeZylosDir();
  fs.writeFileSync(path.join(zylosDir, '.codex', 'config.toml'), 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n');
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-5.4',
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }]
    }]
  }));

  const meta = getActionsMeta({ runtime: 'codex', codex_new_session_threshold: '75', zylosDir }, {});

  assert.equal(meta.runtime, 'codex');
  assert.ok(meta.models.some(model => model.id === 'gpt-6.1-sol'));
  assert.ok(meta.models.some(model => model.id === 'gpt-5.4'));
  assert.deepEqual(meta.efforts_by_model['gpt-5.4'], []);
  assert.equal(meta.current_model, 'gpt-5.4');
  assert.equal(meta.current_effort, 'high');
  assert.equal(meta.new_session_threshold, 75);

  fs.rmSync(zylosDir, { recursive: true, force: true });
}));

test('getActionsMeta ignores user-level Codex root model config', () => withCodexHome((codexHome) => {
  const zylosDir = makeZylosDir();
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\nmodel_reasoning_effort = "low"\n');
  fs.writeFileSync(path.join(zylosDir, '.codex', 'config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n');
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-5.4', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
      { slug: 'gpt-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] }
    ]
  }));

  const meta = getActionsMeta({ runtime: 'codex', zylosDir }, {});

  assert.equal(meta.current_model, 'gpt-5.5');
  assert.equal(meta.current_effort, 'medium');

  fs.rmSync(zylosDir, { recursive: true, force: true });
}));

test('getActionsMeta keeps runtime evidence separate from unset configuration', () => withCodexHome((dir) => {
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      visibility: 'list',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }]
    }]
  }));

  const meta = getActionsMeta(
    { runtime: 'codex', codex_new_session_threshold: '75', zylosDir: dir },
    { model: 'GPT-5.5', model_id: 'gpt-5.5' }
  );

  assert.equal(meta.current_model, null);
  assert.equal(meta.current_effort, null);
  assert.equal(meta.running_model, 'gpt-5.5');
  assert.deepEqual(meta.efforts_by_model['gpt-5.5'], []);
}));

test('getActionsMeta keeps Claude model and effort controls for Claude runtime', () => {
  const meta = getActionsMeta(
    { runtime: 'claude', new_session_threshold: '36', zylosDir: '/tmp/zylos-dashboard-missing' },
    { effort: 'medium' }
  );

  assert.equal(meta.runtime, 'claude');
  assert.ok(meta.models.length > 0);
  assert.ok(Object.keys(meta.efforts_by_model).length > 0);
  assert.equal(meta.current_effort, 'medium');
  assert.equal(meta.new_session_threshold, 70, 'without a configured model the legacy value has no model identity');
});
test('Claude model list includes defaults with display names and specific versions', () => {
  const meta = getActionsMeta(
    { runtime: 'claude', zylosDir: '/tmp/zylos-dashboard-missing' },
    {}
  );

  const ids = meta.models.map(m => m.id);
  assert.ok(ids.includes('fable[1m]'), 'default fable 1M alias');
  assert.ok(ids.includes('claude-fable-5[1m]'), 'specific fable 5 1M');
  assert.ok(!ids.includes('fable'), 'no 200k fable variant — 1M only');
  assert.ok(!ids.includes('claude-fable-5'), 'no 200k fable variant — 1M only');
  assert.ok(ids.includes('opus'), 'default opus alias');
  assert.ok(ids.includes('opus[1m]'), 'default opus 1M alias');
  assert.ok(ids.includes('sonnet'), 'default sonnet alias');
  assert.ok(ids.includes('haiku'), 'default haiku alias');
  assert.ok(ids.includes('claude-opus-4-8'), 'specific opus 4.8');
  assert.ok(ids.includes('claude-opus-4-8[1m]'), 'specific opus 4.8 1M');
  assert.ok(ids.includes('claude-haiku-4-5-20251001'), 'specific haiku');
  for (const id of ['claude-fable-5-1[1m]', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-5']) {
    assert.ok(ids.includes(id), `specific 5-series model ${id}`);
  }
  assert.ok(!ids.includes('claude-fable-5-1'), 'no 200k fable 5.1 variant — 1M only');
  assert.ok(!ids.includes('claude-sonnet-5[1m]'), 'Sonnet 5 is natively 1M; no [1m] variant');

  const opusDefault = meta.models.find(m => m.id === 'opus');
  assert.ok(opusDefault.display_name, 'opus has display_name');
  assert.ok(meta.models.find(m => m.id === 'fable[1m]').display_name, 'fable has display_name');
  assert.ok(!meta.models.find(m => m.id === 'claude-opus-4-8').display_name, 'specific version has no display_name');
});

test('Claude effort mappings: xhigh for Fable/Opus 4.8+/Opus 5/Sonnet 5/aliases, none for Haiku', () => {
  const meta = getActionsMeta(
    { runtime: 'claude', zylosDir: '/tmp/zylos-dashboard-missing' },
    {}
  );

  const e = meta.efforts_by_model;
  assert.deepStrictEqual(e['fable[1m]'], ['low', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(e['claude-fable-5[1m]'], ['low', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(e['opus'], ['low', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(e['opus[1m]'], ['low', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(e['claude-opus-4-8'], ['low', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(e['claude-opus-4-8[1m]'], ['low', 'medium', 'high', 'xhigh']);
  for (const id of ['claude-fable-5-1[1m]', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-5']) {
    assert.deepStrictEqual(e[id], ['low', 'medium', 'high', 'xhigh'], id);
  }
  assert.deepStrictEqual(e['claude-opus-4-6'], ['low', 'medium', 'high']);
  assert.deepStrictEqual(e['claude-sonnet-4-6'], ['low', 'medium', 'high']);
  assert.deepStrictEqual(e['haiku'], []);
  assert.deepStrictEqual(e['claude-haiku-4-5-20251001'], []);
  assert.deepStrictEqual(e['*'], ['low', 'medium', 'high']);
});

test('handleAction stores Codex model and effort in config.toml', async () => {
  await withCodexHome(async (codexHome) => {
    const zylosDir = makeZylosDir();
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      models: [{
        slug: 'gpt-5.5',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'xhigh' }]
      }]
    }));

    const modelResult = await handleAction('switch-model', { model: 'gpt-6.1-sol' }, { runtime: 'codex', zylosDir });
    assert.equal(modelResult.ok, true);
    const effortResult = await handleAction('switch-effort', { effort: 'xhigh' }, { runtime: 'codex', zylosDir });
    assert.equal(effortResult.ok, true);

    const config = fs.readFileSync(path.join(zylosDir, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /^model = "gpt-6\.1-sol"$/m);
    assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
    assert.equal(fs.existsSync(path.join(codexHome, 'config.toml')), false);

    fs.rmSync(zylosDir, { recursive: true, force: true });
  });
});

test('handleAction upgrades Codex CLI under Codex runtime', async () => {
  const prevPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-upgrade-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const marker = path.join(dir, 'updated.txt');
  const codexBin = path.join(binDir, 'codex');
  fs.writeFileSync(codexBin, `#!/bin/sh\nif [ "$1" = "update" ]; then echo updated > ${JSON.stringify(marker)}; echo "codex updated"; exit 0; fi\nexit 2\n`);
  fs.chmodSync(codexBin, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;

  try {
    const result = await handleAction('upgrade-cc', {}, { runtime: 'codex' });
    assert.equal(result.ok, true);
    assert.equal(result.messageKey, 'result.codex_updated');
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'updated');
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('metadata exposes per-model thresholds, 1M limits and requested custom models', () => withCodexHome(codexHome => {
  const zylosDir = makeZylosDir();
  try {
    fs.writeFileSync(path.join(zylosDir, '.codex/config.toml'), 'model = "small"\n');
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'small', context_window: 200000 }, { slug: 'custom-large', context_window: 1000000, effective_context_window_percent: 95 } ] }));
    const meta = getActionsMeta({ runtime: 'codex', zylosDir, thresholdModel: 'custom-large', codex_new_session_threshold: 74,
      model_rotation_thresholds: { codex: { small: 62, 'custom-large': 35 } } }, {});
    assert.equal(meta.model_thresholds.small, 62); assert.equal(meta.new_session_threshold, 62);
    assert.equal(meta.model_thresholds['custom-large'], 35); assert.equal(meta.model_threshold_max['custom-large'], 40);
    assert.equal(meta.model_threshold_max.small, 95);
  } finally { fs.rmSync(zylosDir, { recursive: true, force: true }); }
}));

test('threshold writes require a model and engine, preserve another model and reject values above its window limit', async () => {
  const zylosDir = makeZylosDir();
  try {
    fs.mkdirSync(path.join(zylosDir, '.zylos')); fs.mkdirSync(path.join(zylosDir, '.claude'));
    fs.writeFileSync(path.join(zylosDir, '.claude/settings.json'), JSON.stringify({ model: 'opus' }));
    fs.writeFileSync(path.join(zylosDir, '.zylos/config.json'), JSON.stringify({ new_session_threshold: 68 }));
    const config = { zylosDir, runtime: 'codex' };
    assert.equal((await handleAction('set-threshold', { model: 'opus', value: 63 }, config)).error, 'INVALID_RUNTIME');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', value: 63 }, config)).error, 'invalid_model');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: 41 }, config)).error, 'invalid_value');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: '35junk' }, config)).error, 'invalid_value');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: true }, config)).error, 'invalid_value');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: 35 }, config)).ok, true);
    const stored = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos/config.json'), 'utf8'));
    assert.equal(stored.model_rotation_thresholds.claude.opus, 68);
    assert.equal(stored.model_rotation_thresholds.claude['opus[1m]'], 35);
    assert.equal(stored.new_session_threshold, 68, 'legacy key remains unchanged');
  } finally { fs.rmSync(zylosDir, { recursive: true, force: true }); }
});

test('changing the default model pins the legacy threshold before the model changes', async () => {
  const zylosDir = makeZylosDir();
  try {
    fs.mkdirSync(path.join(zylosDir, '.zylos')); fs.mkdirSync(path.join(zylosDir, '.claude'));
    fs.writeFileSync(path.join(zylosDir, '.claude/settings.json'), JSON.stringify({ model: 'opus' }));
    fs.writeFileSync(path.join(zylosDir, '.zylos/config.json'), JSON.stringify({ new_session_threshold: 64 }));
    assert.equal((await handleAction('switch-model', { runtime: 'claude', model: 'sonnet' }, { zylosDir })).ok, true);
    const stored = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos/config.json'), 'utf8'));
    const meta = getActionsMeta({ ...stored, zylosDir, runtime: 'claude' }, {});
    assert.equal(meta.model_thresholds.opus, 64); assert.equal(meta.model_thresholds.sonnet, 70);
  } finally { fs.rmSync(zylosDir, { recursive: true, force: true }); }
});


test('metadata reads the same root TOML model syntax as threshold migration', () => withCodexHome(() => {
  const zylosDir = makeZylosDir();
  try {
    for (const source of ["model = 'private-codex'\n[profile.other]\nmodel = \"other\"\n", 'model = "private-codex" # instance default\n[profile.other]\nmodel = "other"\n']) {
      fs.writeFileSync(path.join(zylosDir, '.codex/config.toml'), source);
      const meta = getActionsMeta({ runtime: 'codex', zylosDir, codex_new_session_threshold: 75 }, {});
      assert.equal(meta.current_model, 'private-codex'); assert.equal(meta.new_session_threshold, 75);
      assert.equal(meta.model_thresholds['private-codex'], 75);
    }
  } finally { fs.rmSync(zylosDir, { recursive: true, force: true }); }
}));
