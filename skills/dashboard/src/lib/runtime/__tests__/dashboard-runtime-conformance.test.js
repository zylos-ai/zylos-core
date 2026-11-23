import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getActionsMeta, handleAction } from '../../actions.js';
import { loadCoreModule } from '../../core-modules.js';
import { HistoryService } from '../../history/history-service.js';
import { DASHBOARD_CAPABILITIES, UNSUPPORTED } from '../contract.js';
import { getDashboardRuntime } from '../index.js';

const { getRuntime, SUPPORTED_RUNTIMES, runtimesWith } = await loadCoreModule('runtime/index.js');
const coreContract = await loadCoreModule('runtime/contract.js');

test('Dashboard runtime objects conform to the contract and registry', async () => {
  assert.equal(UNSUPPORTED, coreContract.UNSUPPORTED);
  let legacyPricingKeys = 0;
  for (const id of SUPPORTED_RUNTIMES) {
    const promise = getDashboardRuntime(id);
    assert.equal(getDashboardRuntime(id), promise);
    const runtime = await promise;
    assert.equal(runtime.id, id);
    assert.ok(Object.isFrozen(runtime));
    assert.deepEqual(Object.keys(runtime).sort(), [
      'activityVocabulary', 'collector', 'history', 'id', 'modelCatalog', 'pricing',
    ]);
    for (const [capability, { required, members }] of Object.entries(DASHBOARD_CAPABILITIES)) {
      assert.ok(Object.hasOwn(runtime, capability), `${id} lacks ${capability}`);
      const value = runtime[capability];
      assert.ok(value != null, `use UNSUPPORTED for ${id}.${capability}`);
      if (value === UNSUPPORTED) {
        assert.equal(required, false);
      } else if (members) {
        assert.ok(Object.isFrozen(value), `${id}.${capability} must be frozen`);
        for (const [member, requirement] of Object.entries(members)) {
          const label = `${id}.${capability}.${member}`;
          assert.ok(Object.hasOwn(value, member) && value[member] != null, `missing ${label}`);
          if (requirement === 'required') assert.notEqual(value[member], UNSUPPORTED, label);
        }
      } else {
        assert.equal(typeof value, 'function', `${id}.${capability} must be a class`);
      }
    }

    const hasUsage = runtimesWith('usage').includes(id);
    for (const capability of ['collector', 'history', 'pricing']) {
      assert.equal(runtime[capability] !== UNSUPPORTED, hasUsage, `${id}.${capability} must agree with usage`);
    }
    if (hasUsage) {
      assert.equal(runtime.pricing.id, id);
      if (runtime.pricing.legacyKeys !== UNSUPPORTED) legacyPricingKeys++;
    }
    const hasModelOverride = runtimesWith('modelOverride').includes(id);
    assert.equal(runtime.modelCatalog !== UNSUPPORTED, hasModelOverride);
    const { modelConfig } = (await getRuntime(id)).launch;
    assert.equal(modelConfig !== UNSUPPORTED, hasModelOverride);
  }
  assert.ok(legacyPricingKeys <= 1);
  for (const id of ['foo', 'constructor', '__proto__']) {
    await assert.rejects(getDashboardRuntime(id), { code: 'RUNTIME_UNSUPPORTED' });
  }
});

test('Antigravity has no model overrides or transcript parser', async t => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-unsupported-runtime-'));
  t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  const config = { runtime: 'agy', zylosDir };

  const meta = getActionsMeta(config);
  assert.deepEqual(meta.models, []);
  assert.equal(meta.catalog_strict, null);
  assert.deepEqual(await handleAction('switch-model', { model: 'gemini-x' }, config), { ok: false, error: 'INVALID_RUNTIME' });
  assert.equal(fs.existsSync(path.join(zylosDir, '.codex/config.toml')), false);
  assert.deepEqual(await handleAction('switch-effort', { effort: 'high' }, config), { ok: false, error: 'INVALID_RUNTIME' });

  const { parser } = new HistoryService({ config });
  assert.equal(parser.constructor.name, 'EmptyHistory');
  assert.deepEqual(await parser.listSessions(), { current: null, sessions: [] });
});
