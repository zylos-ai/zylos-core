import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effortOptionState,
  mergeRuntimeInfo,
  modelOptionState,
} from '../public/js/runtime-ui.js';

test('Codex choices remain unset when configuration is absent', () => {
  const meta = {
    runtime: 'codex', models: [{ id: 'known', display_name: 'Known' }],
    current_model: null, current_effort: null, efforts_by_model: { known: ['low', 'high'] },
  };
  assert.deepEqual(modelOptionState(meta), {
    options: [
      { value: '', labelKey: 'actions.unset', disabled: true, selected: true },
      { value: 'known', label: 'Known', selected: false },
      { value: '__custom__', labelKey: 'actions.custom' },
    ],
    custom: false,
    customValue: '',
  });
  assert.deepEqual(effortOptionState(meta, 'known'), {
    hidden: false,
    disabled: false,
    options: [
      { value: '', labelKey: 'actions.unset', labelParams: undefined, disabled: true, selected: true },
      { value: 'low', selected: false },
      { value: 'high', selected: false },
    ],
  });
  assert.deepEqual(effortOptionState(meta, 'unrecognized'), {
    hidden: false,
    disabled: true,
    options: [{ value: '', labelKey: 'actions.unset', labelParams: undefined, disabled: true, selected: true }],
  });
});

test('configured unknown choices are preserved without inventing effort support', () => {
  const meta = {
    runtime: 'codex', models: [{ id: 'known', display_name: 'Known' }],
    current_model: 'relay-model', current_effort: 'ultra', efforts_by_model: { 'relay-model': [] },
  };
  const model = modelOptionState(meta);
  assert.equal(model.custom, true);
  assert.equal(model.customValue, 'relay-model');
  assert.deepEqual(effortOptionState(meta, 'relay-model', meta.current_effort, value => value === 'ultra' ? 'Maximum' : value), {
    hidden: false,
    disabled: true,
    options: [{
      value: '', labelKey: 'actions.effort_unavailable', labelParams: { value: 'Maximum' },
      disabled: true, selected: true,
    }],
  });
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} known configured choices stay selected`, () => {
    const meta = {
      runtime, models: [{ id: 'known', display_name: 'Known' }], current_model: 'known',
      current_effort: 'high', efforts_by_model: { known: ['low', 'high'] },
    };
    assert.equal(modelOptionState(meta).options.find(option => option.value === 'known').selected, true);
    const effort = effortOptionState(meta, 'known');
    assert.equal(effort.hidden, false);
    assert.equal(effort.disabled, false);
    assert.equal(effort.options.find(option => option.value === 'high').selected, true);
  });
}

test('effort options keep a chosen effort across model changes and disable when a model has none', () => {
  const meta = {
    runtime: 'codex', current_model: 'a', current_effort: null,
    efforts_by_model: { a: ['low', 'medium', 'high'], b: ['low', 'medium', 'high'], none: [] },
  };
  assert.equal(effortOptionState(meta, 'b', 'high').options.find(o => o.value === 'high').selected, true);
  assert.equal(effortOptionState(meta, 'none', 'high').disabled, true);
  assert.equal(effortOptionState(meta, 'a', 'high').options.find(o => o.value === 'high').selected, true);
});

test('SSE runtime identity is retained for the same target and cleared on target change', () => {
  const previous = {
    session: { session_id: 'old' }, runtime_info: {
      runtime: 'codex', model: 'old-model', model_id: 'old-model', effort: 'high',
      service_tier: 'priority', configured_model: 'configured',
    },
  };
  assert.equal(mergeRuntimeInfo(previous, { session: { session_id: 'old' } }), previous.runtime_info);
  assert.deepEqual(mergeRuntimeInfo(previous, { session: { session_id: 'new' } }), {
    runtime: 'unknown', model: null, model_id: null, effort: null, service_tier: null,
    configured_model: 'configured',
  });
});
