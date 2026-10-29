import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const translations = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'));
function translate(key, values = {}) {
  return Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), translations[key] || key);
}
function element() {
  return { textContent: '', innerHTML: '', hidden: false, classList: { add() {}, remove() {}, toggle() {} } };
}

test('compact Codex info bar uses runtime evidence without configured values or tier', () => {
  const bar = element();
  const context = vm.createContext({
    state: { dashboardState: { runtime_info: { runtime: 'codex', configured_model: 'gpt-6.1-sol', configured_effort: 'high' } } },
    $: () => bar, renderIdentityChrome() {}, esc: value => value, t: translate,
    effortLabel: value => value, remoteIsReadOnly: () => false
  });
  vm.runInContext(app.slice(app.indexOf('function renderInfoBar()'), app.indexOf('// ─── Render: State')), context);
  context.renderInfoBar();
  assert.match(bar.innerHTML, /Model: Unknown.*Effort: Unknown/);
  assert.doesNotMatch(bar.innerHTML, /Configured|Tier:|gpt-6.1-sol|high/);
  context.state.dashboardState.runtime_info = { runtime: 'codex', zylos_version: '0.9.0', model: 'gpt-6-sol', effort: 'medium', service_tier: 'priority', codex_running: '0.162.1', codex_installed: '0.163.0' };
  context.renderInfoBar();
  assert.match(bar.innerHTML, /zylos v0.9.0 · Model: gpt-6-sol · Effort: medium · Codex v0.162.1/);
  assert.doesNotMatch(bar.innerHTML, /Configured|Tier:|priority|0.163.0|gpt-6.1-sol|high/);
  context.state.dashboardState.runtime_info = { runtime: 'claude', model: 'Opus 4.6', effort: 'high' };
  context.renderInfoBar();
  assert.match(bar.innerHTML, /Opus 4.6 · high/);
  assert.doesNotMatch(bar.innerHTML, /Model:|Tier:|Unknown/);
});

function actionsHarness(meta) {
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) {
      const el = element();
      el.options = [];
      el._value = '';
      Object.defineProperties(el, {
        value: { get() { return this._value; }, set(value) { this._value = value; } },
        innerHTML: { get() { return ''; }, set() { this.options = []; this._value = ''; } }
      });
      el.appendChild = function (option) {
        this.options.push(option);
        if (this.options.length === 1 || option.selected) this.value = option.value;
      };
      elements.set(selector, el);
    }
    return elements.get(selector);
  };
  const modal = { querySelector: get };
  const context = vm.createContext({ state: {}, createActionsModal: () => modal, updateRestartDot() {},
    fetchJson: async () => meta, document: { createElement: element }, t: translate, effortLabel: value => value,
    remoteIsReadOnly: () => false });
  vm.runInContext(app.slice(app.indexOf('async function openActionsModal()'), app.indexOf('function closeActionsModal()')), context);
  return { context, modal, get };
}

test('Codex action selects remain unset with no configuration and reject unknown capabilities', async () => {
  const h = actionsHarness({ runtime: 'codex', models: [{ id: 'known', display_name: 'Known' }],
    current_model: null, current_effort: null, efforts_by_model: { known: ['low', 'high'] } });
  await h.context.openActionsModal();
  assert.equal(h.get('#action-model').value, '');
  assert.equal(h.get('#action-model').options[0].textContent, 'Unset');
  assert.equal(h.get('#action-effort').value, '');
  assert.equal(h.get('#action-effort').disabled, true);
  h.modal._renderEffortOptions('known');
  assert.equal(h.get('#action-effort').value, '');
  assert.equal(h.get('#action-effort').disabled, false);
  h.modal._renderEffortOptions('unrecognized');
  assert.equal(h.get('#action-effort').value, '');
  assert.equal(h.get('#action-effort').options.length, 1);
  assert.equal(h.get('#action-effort').disabled, true);
});

test('configured unknown model is preserved without inventing its effort support', async () => {
  const h = actionsHarness({ runtime: 'codex', models: [{ id: 'relay-model', display_name: 'relay-model' }],
    current_model: 'relay-model', current_effort: 'ultra', efforts_by_model: { 'relay-model': [] } });
  await h.context.openActionsModal();
  assert.equal(h.get('#action-model').value, 'relay-model');
  assert.equal(h.get('#action-effort').value, '');
  assert.equal(h.get('#action-effort').options[0].textContent, 'ultra (capability unavailable)');
  assert.equal(h.get('#action-effort').disabled, true);
});

test('known configured choices stay selected for Codex and Claude', async () => {
  for (const runtime of ['codex', 'claude']) {
    const h = actionsHarness({ runtime, models: [{ id: 'known', display_name: 'Known' }],
      current_model: 'known', current_effort: 'high', efforts_by_model: { known: ['low', 'high'] } });
    await h.context.openActionsModal();
    assert.equal(h.get('#action-model').value, 'known');
    assert.equal(h.get('#action-effort').value, 'high');
    assert.equal(h.get('#action-effort').disabled, false);
  }
});

test('action change from an unset value submits only explicit choices and restores unset on rejection', async () => {
  const calls = [];
  const context = vm.createContext({ execAction: async (...args) => { calls.push(args); return false; } });
  vm.runInContext(app.slice(app.indexOf('  async function selectAction('), app.indexOf("  const modelSel = overlay.querySelector('#action-model');")), context);
  const select = { value: '', _prevValue: '' };
  await context.selectAction(select, 'switch-model', 'model');
  assert.equal(calls.length, 0);
  select.value = 'known';
  await context.selectAction(select, 'switch-model', 'model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].model, 'known');
  assert.equal(select.value, '');
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} effort saves survive model changes, cancellation and rejected saves`, async () => {
    const meta = {
      runtime, current_model: 'a', current_effort: runtime === 'codex' ? null : 'medium',
      models: [{ id: 'a' }, { id: 'b' }, { id: 'no-effort' }],
      efforts_by_model: { a: ['low', 'medium', 'high'], b: ['low', 'medium', 'high'], 'no-effort': [] }
    };
    const h = actionsHarness(meta);
    await h.context.openActionsModal();
    const effort = h.get('#action-effort');
    const model = h.get('#action-model');
    const handlers = {};
    model.addEventListener = (event, handler) => { handlers[event] = handler; };
    let accept = true;
    const calls = [];
    h.context.execAction = async (action, body) => { calls.push({ action, body }); return accept; };
    h.context.actionsModal = h.modal;
    h.context.modelSel = model;
    h.context.modelCustom = { value: '' };
    h.context.setCustomModelMode = () => {};
    vm.runInContext(app.slice(app.indexOf('  async function selectAction('),
      app.indexOf("  const modelSel = overlay.querySelector('#action-model');")), h.context);
    vm.runInContext(app.slice(app.indexOf("  modelSel.addEventListener('change', async () => {"),
      app.indexOf('  async function submitCustomModel()')), h.context);

    effort.value = 'high';
    await h.context.selectAction(effort, 'switch-effort', 'effort');
    assert.equal(effort._prevValue, 'high');

    accept = false;
    model.value = 'b';
    await handlers.change();
    assert.equal(model.value, 'a');
    assert.equal(effort.value, 'high');

    accept = true;
    model.value = 'b';
    await handlers.change();
    assert.equal(model.value, 'b');
    assert.equal(effort.value, 'high');
    effort.value = 'low';
    await h.context.selectAction(effort, 'switch-effort', 'effort');
    model.value = 'a';
    await handlers.change();
    assert.equal(effort.value, 'low');

    accept = false;
    effort.value = 'medium';
    await h.context.selectAction(effort, 'switch-effort', 'effort');
    assert.equal(effort.value, 'low');
    model.value = 'b';
    await handlers.change();
    assert.equal(effort.value, 'low');

    accept = true;
    model.value = 'no-effort';
    await handlers.change();
    assert.equal(effort.disabled, true);
    model.value = 'a';
    await handlers.change();
    assert.equal(effort.disabled, false);
    assert.equal(effort.value, 'low');
    assert.equal(calls.filter(call => call.action === 'switch-effort').length, 3);
  });

  test(`${runtime} rejected first effort save does not change the original selection`, async () => {
    const current = runtime === 'codex' ? null : 'medium';
    const h = actionsHarness({ runtime, current_model: 'a', current_effort: current,
      models: [{ id: 'a' }], efforts_by_model: { a: ['low', 'medium', 'high'] } });
    await h.context.openActionsModal();
    h.context.execAction = async () => false;
    vm.runInContext(app.slice(app.indexOf('  async function selectAction('),
      app.indexOf("  const modelSel = overlay.querySelector('#action-model');")), h.context);
    const effort = h.get('#action-effort');
    effort.value = 'high';
    await h.context.selectAction(effort, 'switch-effort', 'effort');
    h.modal._renderEffortOptions('a');
    assert.equal(effort.value, current || '');
  });
}

test('raw SSE session switch clears Codex runtime identity while preserving configuration', () => {
  const context = vm.createContext({ state: { dashboardState: { session: { session_id: 'old' }, runtime_info: {
    runtime: 'codex', model: 'old-model', model_id: 'old-model', effort: 'high', service_tier: 'priority', configured_model: 'configured'
  } } }, applyRuntimeVisibility() {}, renderInfoBar() {}, renderState() {}, renderHealth() {},
  updateRestartDot() {}, refreshTimeline() {}, Date });
  vm.runInContext(app.slice(app.indexOf('function applySse('), app.indexOf("  } else if (name === 'metric_update')")) + '\n  }\n}', context);
  context.applySse('state_change', { session: { session_id: 'old' } });
  assert.equal(context.state.dashboardState.runtime_info.model, 'old-model');
  context.applySse('state_change', { session: { session_id: 'new' } });
  const info = context.state.dashboardState.runtime_info;
  for (const key of ['model', 'model_id', 'effort', 'service_tier']) assert.equal(info[key], null);
  assert.equal(info.configured_model, 'configured');
});
