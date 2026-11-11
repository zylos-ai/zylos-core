import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getActionsMeta, handleAction } from '../src/lib/actions.js';
import { getCodexModels, codexEffortsForModel } from '../src/lib/codex-models.js';
import { codexRuntimeFields } from '../src/lib/runtime-info.js';

test('runtime identity and effort do not borrow configuration or catalog defaults', () => {
  assert.deepEqual(codexRuntimeFields(null, { model: 'gpt-5.6-sol', effort: 'high' }), {
    model: null, model_id: null, effort: null, service_tier: null,
    configured_model: 'gpt-5.6-sol', configured_effort: 'high',
  });
  const fields = codexRuntimeFields({ model_id: 'relay-custom', reasoning_effort: 'max', service_tier: 'priority' }, {
    model: 'gpt-5.6-sol', effort: 'low',
  });
  assert.equal(fields.model, 'relay-custom');
  assert.equal(fields.model_id, 'relay-custom');
  assert.equal(fields.effort, 'max');
  assert.equal(fields.service_tier, 'priority');
});

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
    assert.deepEqual(codexEffortsForModel('fake'), []);
    const models = getCodexModels();
    models[0].efforts.push('invented');
    assert.ok(!codexEffortsForModel(models[0].id).includes('invented'));
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
      assert.equal(meta.running_effort, 'ultra');
      assert.deepEqual(meta.efforts_by_model['runtime-custom'], []);
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
      assert.deepEqual(codexEffortsForModel('gpt-5.6'), codexEffortsForModel('gpt-5.6-sol'));
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
