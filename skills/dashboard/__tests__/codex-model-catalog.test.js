import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getActionsMeta, handleAction } from '../src/lib/actions.js';
import catalog from '../src/lib/runtime/codex/model-catalog.js';

test('catalog is independent of cache existence, corruption and replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-catalog-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    const expected = getActionsMeta({ runtime: 'codex', zylosDir: dir }, {});
    assert.equal(expected.current_model, null);
    assert.equal(expected.current_effort, null);
    for (const contents of ['{broken', JSON.stringify({ models: [{ slug: 'fake', supported_reasoning_levels: [{ effort: 'invented' }] }] })]) {
      fs.writeFileSync(path.join(dir, 'models_cache.json'), contents);
      assert.deepEqual(getActionsMeta({ runtime: 'codex', zylosDir: dir }, {}), expected);
    }
    assert.equal(catalog.effortsFor('fake'), null);
    const models = catalog.models();
    const { id } = models[0];
    catalog.effortsFor(id).push('invented');
    models[0].display_name = 'invented';
    assert.ok(!catalog.effortsFor(id).includes('invented'));
    assert.notEqual(catalog.models()[0].display_name, 'invented');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown or unset configured model rejects effort mutation without writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-unknown-effort-'));
  try {
    fs.mkdirSync(path.join(dir, '.codex'));
    const configPath = path.join(dir, '.codex', 'config.toml');
    for (const model of [null, 'relay-custom']) {
      const original = model ? `model = "${model}"\n` : '# unset\n';
      fs.writeFileSync(configPath, original);
      const result = await handleAction('switch-effort', { effort: model ? 'max' : 'high' }, { runtime: 'codex', zylosDir: dir });
      assert.equal(result.error, 'unknown_model_capabilities');
      assert.equal(fs.readFileSync(configPath, 'utf8'), original);
      const meta = getActionsMeta({ runtime: 'codex', zylosDir: dir }, { model_id: 'runtime-custom', effort: 'ultra' });
      assert.equal(meta.current_model, model);
      assert.equal(meta.current_effort, null);
      for (const key of ['running_model', 'running_effort']) assert.equal(Object.hasOwn(meta, key), false);
      assert.equal(Object.hasOwn(meta.efforts_by_model, 'runtime-custom'), false, 'Origin observations do not expand configuration options');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6']) {
  test(`${model} is selectable and saves supported effort while rejecting invalid effort`, async () => {
    // Each fixture represents its own server with independent request dedup state.
    const { handleAction: isolatedAction } = await import(`../src/lib/actions.js?fixture=${model}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-family-effort-'));
    try {
      fs.mkdirSync(path.join(dir, '.codex'));
      const configPath = path.join(dir, '.codex', 'config.toml');
      fs.writeFileSync(configPath, 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');
      const config = { runtime: 'codex', zylosDir: dir };
      const meta = getActionsMeta(config, {});
      assert.ok(meta.models.some(entry => entry.id === model));
      assert.ok(meta.efforts_by_model[model].includes('max'));
      const switched = await isolatedAction('switch-model', { model }, config);
      assert.equal(switched.ok, true);
      assert.match(fs.readFileSync(configPath, 'utf8'), new RegExp(`model = "${model.replaceAll('.', '\\.')}"`));
      const saved = await isolatedAction('switch-effort', { effort: 'max' }, config);
      assert.equal(saved.ok, true);
      assert.equal(getActionsMeta(config, {}).current_effort, 'max');
      const beforeReject = fs.readFileSync(configPath, 'utf8');
      const invalid = model === 'gpt-5.6' ? 'invented' : 'ultra';
      const rejected = await isolatedAction('switch-effort', { effort: invalid }, config);
      assert.equal(rejected.error, 'invalid_effort');
      assert.equal(fs.readFileSync(configPath, 'utf8'), beforeReject);
      assert.deepEqual(catalog.effortsFor('gpt-5.6'), catalog.effortsFor('gpt-5.6-sol'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('GPT-6.2 models lead the catalog with their Codex display names', () => {
  assert.deepEqual(catalog.models().slice(0, 3).map(({ id, display_name }) => [id, display_name]), [
    ['gpt-6.2-sol', 'GPT-6.2-Sol'], ['gpt-6.2-astra', 'GPT-6.2-Astra'], ['gpt-6.1-sol', 'GPT-6.1-Sol']
  ]);
});

test('GPT-6.1 Terra follows GPT-6.1-Sol under its Codex display name', () => {
  const ids = catalog.models().map(({ id }) => id);
  assert.equal(ids.indexOf('gpt-6.1-terra'), ids.indexOf('gpt-6.1-sol') + 1);
  assert.equal(catalog.models().find(({ id }) => id === 'gpt-6.1-terra').display_name, 'GPT-6.1 Terra');
});

for (const model of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra']) {
  test(`${model} is selectable, saves ultra and rejects invalid effort`, async () => {
    const { handleAction: isolatedAction } = await import(`../src/lib/actions.js?fixture=${model}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-effort-'));
    try {
      fs.mkdirSync(path.join(dir, '.codex'));
      const configPath = path.join(dir, '.codex', 'config.toml');
      fs.writeFileSync(configPath, 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');
      const config = { runtime: 'codex', zylosDir: dir };
      const meta = getActionsMeta(config, {});
      assert.ok(meta.models.some(entry => entry.id === model));
      assert.deepEqual(meta.efforts_by_model[model], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      const switched = await isolatedAction('switch-model', { model }, config);
      assert.equal(switched.ok, true);
      assert.match(fs.readFileSync(configPath, 'utf8'), new RegExp(`^model = "${model.replaceAll('.', '\\.')}"$`, 'm'));
      const saved = await isolatedAction('switch-effort', { effort: 'ultra' }, config);
      assert.equal(saved.ok, true);
      const after = getActionsMeta(config, {});
      assert.equal(after.current_model, model);
      assert.equal(after.current_effort, 'ultra');
      const beforeReject = fs.readFileSync(configPath, 'utf8');
      const rejected = await isolatedAction('switch-effort', { effort: 'invented' }, config);
      assert.equal(rejected.error, 'invalid_effort');
      assert.equal(fs.readFileSync(configPath, 'utf8'), beforeReject);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('production source has no client model cache reader', () => {
  const root = new URL('../src/', import.meta.url);
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    if (!/\.(?:js|cjs)$/.test(entry)) continue;
    assert.doesNotMatch(fs.readFileSync(new URL(entry, root), 'utf8'), /models_cache\.json|readCodexModels/);
  }
});

test('model changes use the root TOML assignment and preserve table values and comments', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-root-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.codex'));
  const file = path.join(dir, '.codex', 'config.toml');
  const config = { runtime: 'codex', zylosDir: dir };
  const singleQuoted = 'model = \'gpt-5.6\'\nmodel_reasoning_effort = "high"\n';
  const profile = '[profiles.x]\nmodel = "gpt-6-sol"\n';

  for (const [name, source, expected, previous, model] of [
    ['single-quoted model', singleQuoted, 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n', 'gpt-5.6', 'gpt-5.5'],
    ['inline comment', 'model = "gpt-5.6" # pinned\n', 'model = "gpt-5.5" # pinned\n', 'gpt-5.6', 'gpt-5.5'],
    ['profile-only model', profile, 'model = "gpt-5.5"\n' + profile, null, 'gpt-5.5'],
    ['already set', singleQuoted, singleQuoted, 'gpt-5.6', 'gpt-5.6'],
  ]) {
    await t.test(name, async () => {
      const { handleAction: dispatch } = await import(`../src/lib/actions.js?root-model=${encodeURIComponent(name)}`);
      fs.writeFileSync(file, source);
      const result = await dispatch('switch-model', { runtime: 'codex', model }, config);
      if (previous === model) {
        assert.equal(result.error, 'already_set');
      } else {
        assert.equal(result.ok, true);
        assert.equal(result.previous, previous);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), expected);
      assert.equal(getActionsMeta(config).current_model, model);
    });
  }
});
