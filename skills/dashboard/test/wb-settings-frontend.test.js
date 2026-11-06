import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { composeSettings, createSettingsLoader, settingsSections, resetSettingsDrafts } from '../public/js/wb/settings.js';
import { defaultGroups, modelFollowers, runtimeHealth, runtimeConfirmation, createOverrideSearch, renderDefaults } from '../public/js/wb/settings-defaults.js';
import { createPricingPanel, appendPriceRow, collectPriceRows, visiblePricePrefixes } from '../public/js/wb/settings-pricing.js';
import { mountThemeControl } from '../public/js/wb/settings-ui.js';
import { renderVersion } from '../public/js/wb/settings-version.js';
import { documentFixture, node } from './fixtures/settings-dom.js';
import { deferred, tick } from './fixtures/workbench-dom.js';
const t = (key, params = {}) => key + (Object.keys(params).length ? ':' + JSON.stringify(params) : '');
function snapshot() {
  return { baselineRuntime: 'claude', hasOlder: true, instance: { runtimeHealth: { codex: { health: 'auth_failed' }, claude: { health: 'missing' } } },
    overrides: { runtime: [{ sessionGroup: 'a', runtime: 'codex' }], model: [{ sessionGroup: 'b', runtime: 'claude' }] },
    rows: ['origin', 'a', 'b', 'c'].map(sessionGroup => ({ sessionGroup, presence: 'running', name: { displayName: 'Name ' + sessionGroup }, target: { runtime: sessionGroup === 'a' ? 'codex' : 'claude' } })) };
}

test('default lists use independent sources, include Origin, and never enumerate all overrides', () => {
  const data = snapshot(), value = defaultGroups(data, { runtimeTotal: 3, runtime: [] });
  assert.equal(value.followers.length, 3); assert.equal(value.total, 3); assert.equal(value.flat.length, 1); assert.equal(value.older, true);
  assert.equal(defaultGroups(data, { runtimeTotal: 1 }).older, false);
  assert.equal(defaultGroups({ ...data, hasOlder: null }, { runtimeTotal: 3 }).older, false);
  assert.equal(defaultGroups({ ...data, rows: [{ presence: 'running' }], hasOlder: null }, { runtimeTotal: 3 }).flat.length, 0);
  const failed = defaultGroups({ ...data, overrides: null }, { runtimeTotal: 3 });
  assert.equal(failed.followers, null); assert.equal(failed.flat.length, 0); assert.equal(failed.total, 3); assert.equal(failed.older, false);
  const pageFailed = defaultGroups(data, null); assert.equal(pageFailed.followers.length, 3); assert.equal(pageFailed.flat.length, 1); assert.equal(pageFailed.total, null); assert.equal(pageFailed.older, false);
  assert.equal(defaultGroups({ ...data, baselineRuntime: null }, null).baseline, null);
  assert.equal(modelFollowers(data, 'claude').length, 2); assert.equal(modelFollowers({ ...data, overrides: null }, 'claude'), null);
});

test('runtime health and interruption confirmation retain unknown and unavailable distinctions', () => {
  const data = snapshot(); assert.equal(runtimeHealth(data, 'claude'), 'available'); assert.equal(runtimeHealth(data, 'codex'), 'unavailable');
  assert.equal(runtimeHealth({ instance: { runtimeHealth: null } }, 'codex'), 'unknown');
  assert.match(runtimeConfirmation(data, t), /Name origin/); assert.doesNotMatch(runtimeConfirmation(data, t), /Name a\n/);
  assert.match(runtimeConfirmation({ ...data, overrides: null }, t), /cannotList/);
  const many = { ...data, overrides: { runtime: [] }, rows: Array.from({ length: 8 }, (_, i) => ({ sessionGroup: String(i), presence: 'running', name: { displayName: 'Group ' + i } })) };
  const text = runtimeConfirmation(many, t); assert.match(text, /Group 4/); assert.doesNotMatch(text, /Group 5/); assert.match(text, /moreGroups.*8/);
});

test('override search shares search and more generations and ignores late responses after clear', async () => {
  let fire; const reads = [], changes = [];
  const search = createOverrideSearch({ read: path => { const result = deferred(); reads.push({ path, ...result }); return result.promise; }, onChange: value => changes.push(value), setTimer: fn => { fire = fn; return 1; }, clearTimer() {} });
  search.input('AbC'); fire(); assert.equal(reads.length, 1); assert.match(reads[0].path, /q=AbC/);
  search.input('竞品'); fire(); reads[1].resolve({ runtime: [{ sessionGroup: 'new' }], nextAfter: 'next' }); await tick();
  reads[0].resolve({ runtime: [{ sessionGroup: 'old' }] }); await tick(); assert.equal(changes.at(-1).rows[0].sessionGroup, 'new');
  const more = search.more(); assert.match(reads[2].path, /after=next/); assert.match(reads[2].path, /q=/);
  search.input(''); assert.equal(reads.length, 3); assert.equal(changes.at(-1), null);
  reads[2].resolve({ runtime: [{ sessionGroup: 'late' }] }); await more; assert.equal(changes.at(-1), null);
  search.destroy();
});

test('override search appends one batch and reports read failures without replacing prior results', async () => {
  let fire, calls = 0; const changes = [];
  const search = createOverrideSearch({ read: async () => { calls++; if (calls === 1) return { runtime: [{ sessionGroup: 'one' }], nextAfter: 'one' }; if (calls === 2) return { runtime: [{ sessionGroup: 'two' }], nextAfter: 'two' }; throw Error('502'); }, onChange: value => changes.push(value), setTimer: fn => { fire = fn; return 1; }, clearTimer() {} });
  search.input('oc_'); await fire(); await search.more(); assert.equal(changes.at(-1).rows.length, 2); await search.more(); assert.equal(changes.at(-1).rows.length, 2); assert.equal(changes.at(-1).error.message, '502'); search.destroy();
});

test('settings loader reads one group snapshot and one first batch on each open and invalidates stale opens', async () => {
  const paths = [], loads = [], pending = [];
  const loader = createSettingsLoader({ read: path => { paths.push(path); const item = deferred(); pending.push(item); return item.promise; }, onLoad: value => loads.push(value) });
  const first = loader.open(); assert.equal(paths.filter(path => path === '/api/workbench/groups').length, 1); assert.equal(paths.filter(path => path === '/api/workbench/runtime-overrides').length, 1);
  loader.invalidate(); pending.forEach(item => item.resolve({ runtimeTotal: 100000, runtime: [], nextAfter: 'next' })); await first; assert.equal(loads.length, 0);
  const second = loader.open(); pending.slice(6).forEach(item => item.resolve({ runtimeTotal: 100000, runtime: [], nextAfter: 'next' })); await second;
  assert.equal(loads.length, 1); assert.equal(paths.length, 12); assert.equal(paths.some(path => path.includes('after=')), false);
});

test('default controls keep auth gate on runtime switch and send runtime for saved model and effort', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const meta = runtime => ({ runtime, current_model: 'one', current_effort: 'high', models: [{ id: 'one' }, { id: 'two' }], efforts_by_model: { one: ['high'], two: ['low'] } });
  const panel = renderDefaults(root, { snapshot: snapshot(), page: { runtimeTotal: 100000 }, metadata: { claude: meta('claude'), codex: meta('codex') }, document, t, read: async () => ({}), execute: async (action, body) => { calls.push({ action, body }); return true; } });
  assert.equal(root.querySelector('#settings-use-codex').disabled, true); assert.match(root.querySelector('#settings-use-codex').title, /unavailable/);
  assert.equal(root.querySelector('#settings-save-model-codex').disabled, false);
  const model = root.querySelector('#settings-model-codex'); model.value = 'two'; await model.dispatch('input');
  const effort = root.querySelector('#settings-effort-codex'); effort.value = 'low'; await root.querySelector('#settings-save-effort-codex').dispatch('click');
  assert.equal(calls[0].body.runtime, 'codex'); assert.equal(calls[0].body.effort, 'low');
  model.value = 'unknown'; await model.dispatch('input'); effort.disabled = false; panel.refreshLocks(); assert.equal(effort.disabled, true); assert.equal(root.querySelector('#settings-save-effort-codex').disabled, true);
  assert.ok(root.querySelector('#settings-overrides-search')); panel.destroy();
});

test('zero override count hides search and local follower filtering sends no request', async () => {
  const document = documentFixture(), root = document.createElement('div'); let reads = 0;
  const panel = renderDefaults(root, { snapshot: snapshot(), page: { runtimeTotal: 0 }, document, t, read: () => { reads++; } });
  assert.equal(root.querySelector('#settings-overrides-search'), null);
  const search = root.querySelector('input'); search.value = 'Name b'; await search.dispatch('input'); assert.equal(reads, 0);
  assert.equal(root.querySelector('details').querySelectorAll('button').length, 1); panel.destroy();
});

function priceFixture() {
  const document = documentFixture(), root = document.createElement('div'), host = root;
  for (const id of ['settings-model-pricing-group', 'settings-priority-pricing-group', 'settings-fast-mode-group']) root.append(node(document, 'div', id));
  const base = node(document, 'tbody', 'settings-price-rows'), priority = node(document, 'tbody', 'settings-priority-price-rows');
  root.querySelector('#settings-model-pricing-group').append(base); root.querySelector('#settings-priority-pricing-group').append(priority);
  root.querySelector('#settings-fast-mode-group').append(node(document, 'input', 'settings-fast-multiplier'));
  for (const id of ['settings-status', 'settings-save', 'settings-add-model', 'settings-add-priority-model']) root.append(node(document, 'button', id));
  const rate = { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 1 };
  const data = { active: 'claude', runtimes: { claude: { builtInModels: ['base', 'unused'], modelPrices: { base: { ...rate, fastModeMultiplier: 3, longContext: { input: 2 } }, unused: rate, custom: rate }, fastMode: { configuredMultiplier: 6 } }, codex: { builtInModels: ['gpt'], modelPrices: { gpt: rate }, priorityModelPrices: { gpt: rate }, builtInPriorityModels: ['gpt'] } } };
  return { document, root, host, base, priority, data, rate };
}

test('two pricing tabs retain hidden builtins, custom deletion, premium rates and explicit multiplier reset in one save', async () => {
  const fixture = priceFixture(), writes = [];
  const panel = createPricingPanel({ ...fixture, data: fixture.data, snapshot: snapshot(), usage: { models: [{ runtime: 'claude', model: 'base-1', cost: 3 }] }, t, write: async body => writes.push(body) });
  assert.equal(fixture.base.children.length, 2);
  fixture.base.children.find(row => row.dataset.prefix === 'custom').remove();
  fixture.base.children[0].querySelectorAll('input')[1].value = '4';
  fixture.root.querySelector('#settings-fast-multiplier').value = '';
  await fixture.root.querySelector('#settings-price-tab-codex').dispatch('click');
  await fixture.root.querySelector('#settings-price-tab-claude').dispatch('click'); assert.equal(fixture.root.querySelector('#settings-fast-multiplier').value, '');
  await panel.save(); assert.equal(writes.length, 1);
  assert.equal(writes[0].runtimes.claude.fastModeMultiplier, null); assert.equal(writes[0].runtimes.claude.modelPrices.base.input, 4);
  assert.equal(writes[0].runtimes.claude.modelPrices.base.fastModeMultiplier, 3); assert.equal(writes[0].runtimes.claude.modelPrices.base.longContext.input, 2);
  assert.ok(writes[0].runtimes.claude.modelPrices.unused); assert.equal(writes[0].runtimes.claude.modelPrices.custom, undefined); assert.ok(writes[0].runtimes.codex.priorityModelPrices.gpt); panel.destroy();
});

test('invalid custom price row blocks the entire two-runtime save and unmatched Add price selects its runtime', async () => {
  const fixture = priceFixture(), writes = [];
  const panel = createPricingPanel({ ...fixture, usage: { models: [], unmatched: [{ runtime: 'codex', model: 'gpt-reserve', tokens: 1400000 }] }, t, write: async body => writes.push(body) });
  const add = fixture.root.querySelectorAll('button').find(button => button.textContent === 'wb.settings.addPrice'); await add.dispatch('click');
  assert.equal(panel.runtime(), 'codex'); assert.ok(fixture.base.children.some(row => row.dataset.prefix === 'gpt-reserve'));
  appendPriceRow(fixture.base, '', fixture.rate, false, fixture); await panel.save(); assert.equal(writes.length, 0); assert.equal(fixture.root.querySelector('#settings-status').textContent, 'model_prefix_required'); panel.destroy();
});

test('price row validation rejects duplicate, blank and nonnumeric prices without discarding premium fields', () => {
  const fixture = priceFixture(); appendPriceRow(fixture.base, 'x', fixture.rate, false, fixture); appendPriceRow(fixture.base, 'x', fixture.rate, false, fixture);
  assert.throws(() => collectPriceRows(fixture.base.children), /duplicate_model_prefix/); fixture.base.children[1].remove();
  fixture.base.children[0].querySelectorAll('input')[1].value = ''; assert.throws(() => collectPriceRows(fixture.base.children), /invalid_model_price/);
  assert.deepEqual(visiblePricePrefixes({ builtInModels: ['gpt', 'gpt-x'], modelPrices: { gpt: {}, 'gpt-x': {}, custom: {} } }, [{ model: 'gpt-x-1' }]), ['gpt-x', 'custom']);
});

test('settings composition moves actual control nodes and preserves their listeners', async () => {
  const document = documentFixture(), root = document.createElement('div'), settings = document.createElement('div'), fleet = document.createElement('div'), actions = document.createElement('div');
  const moved = []; let movedCalls = 0;
  for (const [source, tag, id] of [[settings, 'section', 'settings-model-pricing-group'], [settings, 'section', 'observer-settings-group'], [actions, 'section', 'action-status'], [actions, 'section', 'action-confirm']]) { const control = node(document, tag, id); source.append(control); control.addEventListener('click', () => movedCalls++); moved.push(control); }
  const modeField = node(document, 'div'); modeField.className = 'action-field'; const mode = node(document, 'select', 'action-mode'); modeField.append(mode); actions.append(modeField); let calls = 0; mode.addEventListener('change', () => calls++);
  for (const name of ['fleet', 'keys']) { const panel = node(document, 'section'); panel.className = 'manage-panel'; panel.dataset.panel = name; panel.hidden = true; panel.addEventListener('click', () => movedCalls++); fleet.append(panel); }
  const locale = node(document, 'button', 'locale-toggle');
  const page = composeSettings(root, { settings, fleet, actions, controls: [locale], document, t });
  assert.equal(settingsSections.length, 6); assert.equal(root.querySelector('#action-mode'), mode); await mode.dispatch('change'); assert.equal(calls, 1);
  assert.equal(page.sections.keys.querySelector('.manage-panel').hidden, false); assert.equal(page.sections.ui.querySelector('#locale-toggle'), locale);
  page.select('pricing'); assert.equal(page.sections.pricing.hidden, false); assert.equal(page.sections.defaults.hidden, true);
  page.detail('technical'); page.select('observer'); page.detail('plain'); assert.equal(page.sections.observer.hidden, true); assert.equal(page.sections.defaults.hidden, false);
  assert.equal(root.querySelector('#action-confirm').closest('.modal-body'), null);
  await page.sections.observer.querySelector('#observer-settings-group').dispatch('click');
  await page.sections.fleet.querySelector('.manage-panel').dispatch('click');
  await page.sections.keys.querySelector('.manage-panel').dispatch('click'); assert.equal(movedCalls, 3);
});

test('version panel reuses upgrade control, labels Codex and retains readonly reason and non-action core hint', async () => {
  const document = documentFixture(), root = document.createElement('div'), upgrade = node(document, 'button'); upgrade.append(node(document, 'span', 'action-cli-label'), node(document, 'span', 'action-cc-ver')); let called = 0, hints = 0; upgrade.addEventListener('click', () => called++);
  renderVersion(root, { configured_runtime: 'codex', runtime: 'unknown', codex_running: '1', codex_update: '2', zylos_version: '3', zylos_update: '4' }, { document, upgrade, t, readOnly: true, onHint: () => hints++ });
  assert.equal(upgrade.disabled, true); assert.equal(upgrade.title, 'remote.actions_read_only_tooltip'); assert.match(root.textContent, /Codex.*v1.*↑2/); await root.querySelector('#settings-zylos-update').dispatch('click'); assert.equal(hints, 1); assert.equal(called, 0);
  renderVersion(root, { runtime: 'codex', codex_version: '1' }, { document, upgrade, t, readOnly: false }); await upgrade.dispatch('click'); assert.equal(called, 1); assert.equal(upgrade.disabled, false);
});

test('theme control exposes follow system and forwards the selected value', async () => {
  const document = documentFixture(), root = document.createElement('div'); let value;
  const select = mountThemeControl(root, { document, t, value: 'system', onChange: next => value = next }); assert.equal(select.value, 'system'); assert.equal(select.children.length, 3); select.value = 'dark'; await select.dispatch('change'); assert.equal(value, 'dark');
});

test('removed header entry selectors have no startup bindings and account controls live on the settings page', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const selector of ['info-bar', 'actions-btn', 'settings-btn', 'zylos-update-hint', 'info-bar-update', 'info-bar-text', 'info-bar-buttons']) {
    assert.equal(app.includes('#' + selector), false, 'obsolete selector ' + selector);
    assert.equal(html.includes('id="' + selector + '"'), false, 'obsolete node ' + selector);
  }
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  for (const id of ['locale-toggle', 'fleet-sound-toggle', 'logout-btn', 'wb-detail-toggle']) { assert.equal(header.includes('id="' + id + '"'), false); assert.ok(html.indexOf('id="' + id + '"') > html.indexOf('id="tab-settings"')); }
  assert.match(app, /initSettingsPage\(\);\s*initTabs\(\)/); assert.match(html, /app\.js\?v=83/); assert.match(html, /style\.css\?v=57/);
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.zh.json', import.meta.url))), en = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});


test('settings draft reset clears target-specific controls and disables writes until new data loads', () => {
  const fixture = priceFixture(), defaults = node(fixture.document, 'div', 'settings-defaults'); fixture.root.append(defaults); defaults.append(node(fixture.document, 'button', 'old-target'));
  appendPriceRow(fixture.base, 'old-target', fixture.rate, false, fixture); resetSettingsDrafts(fixture.root);
  assert.equal(defaults.children.length, 0); assert.equal(fixture.base.children.length, 0); assert.equal(fixture.root.querySelector('#settings-save').disabled, true); assert.equal(fixture.root.querySelector('#settings-add-model').disabled, true);
});

test('failed pricing summary is unknown while a successful empty response is zero', () => {
  const failed = priceFixture(); const bad = createPricingPanel({ ...failed, usage: null, write: async () => {}, t }); assert.match(failed.root.textContent, /wb.unknown/); assert.doesNotMatch(failed.root.textContent, /\$0.0000/); bad.destroy();
  const empty = priceFixture(); const good = createPricingPanel({ ...empty, usage: { models: [], unmatched: [] }, write: async () => {}, t }); assert.match(empty.root.textContent, /\$0.0000/); good.destroy();
});
