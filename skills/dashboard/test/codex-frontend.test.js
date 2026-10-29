import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effortOptionState,
  mergeRuntimeInfo,
  modelOptionState,
  runtimeLabels,
  submitSelectAction,
} from '../public/js/runtime-ui.js';

const messages = {
  'info.runtime_model': 'Model: {value}',
  'info.runtime_effort': 'Effort: {value}',
  'info.unknown': 'Unknown',
};

function translate(key, values = {}) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    messages[key] || key,
  );
}

test('compact Codex labels use observed runtime evidence, not configured values or tier', () => {
  assert.deepEqual(runtimeLabels({
    runtime: 'codex', configured_model: 'gpt-6.1-sol', configured_effort: 'high',
  }, translate, value => value), ['Model: Unknown', 'Effort: Unknown']);
  assert.deepEqual(runtimeLabels({
    runtime: 'codex', model: 'gpt-6-sol', effort: 'medium', service_tier: 'priority',
  }, translate, value => value), ['Model: gpt-6-sol', 'Effort: medium']);
  assert.deepEqual(runtimeLabels({
    runtime: 'claude', model: 'Opus 4.6 context', effort: 'high',
  }, translate, value => value), ['Claude', 'Opus 4.6', 'high']);
});

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
  assert.deepEqual(effortOptionState(meta, 'relay-model'), {
    hidden: false,
    disabled: true,
    options: [{
      value: '', labelKey: 'actions.effort_unavailable', labelParams: { value: 'ultra' },
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

test('select submissions ignore unchanged values and restore the previous value on rejection', async () => {
  const calls = [];
  const select = { value: '', _prevValue: '' };
  const execute = async (...args) => { calls.push(args); return false; };
  assert.equal(await submitSelectAction(select, 'switch-model', 'model', execute), false);
  assert.equal(calls.length, 0);
  select.value = 'known';
  assert.equal(await submitSelectAction(select, 'switch-model', 'model', execute), false);
  assert.deepEqual(calls, [['switch-model', { model: 'known' }]]);
  assert.equal(select.value, '');
  assert.equal(select._inFlight, false);
});

test('accepted effort saves survive later model option renders and rejected saves', async () => {
  const meta = {
    runtime: 'codex', current_model: 'a', current_effort: null,
    efforts_by_model: { a: ['low', 'medium', 'high'], b: ['low', 'medium', 'high'], none: [] },
  };
  const effort = { value: '', _prevValue: '', _currentEffort: null };
  const calls = [];
  let accept = true;
  const execute = async (action, body) => { calls.push({ action, body }); return accept; };
  effort.value = 'high';
  assert.equal(await submitSelectAction(effort, 'switch-effort', 'effort', execute), true);
  effort._currentEffort = effort.value;
  assert.equal(effortOptionState(meta, 'b', effort._currentEffort).options.find(o => o.value === 'high').selected, true);
  accept = false;
  effort.value = 'medium';
  assert.equal(await submitSelectAction(effort, 'switch-effort', 'effort', execute), false);
  assert.equal(effort.value, 'high');
  assert.equal(effortOptionState(meta, 'none', effort._currentEffort).disabled, true);
  assert.equal(effortOptionState(meta, 'a', effort._currentEffort).options.find(o => o.value === 'high').selected, true);
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
