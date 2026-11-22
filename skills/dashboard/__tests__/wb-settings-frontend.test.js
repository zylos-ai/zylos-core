import { registerHooks } from 'node:module';
import { formatZoned, setInstanceZone } from '../public/js/wb/instance-zone.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { documentFixture, node } from './fixtures/settings-dom.js';
import { deferred, tick } from './fixtures/workbench-dom.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { composeSettings, createSettingsLoader, settingsSections, resetSettingsDrafts } = await import('../public/js/wb/settings.js');
const { runtimeHealth, runtimeSaveConfirmation, renderDefaults: renderDefaultsCard, renderHotTtl, modelSaveConfirmation } = await import('../public/js/wb/settings-defaults.js');
const { createPricingPanel, appendPriceRow, collectPriceRows, countPriceChanges, draftPriceRows, orderedPricePrefixes } = await import('../public/js/wb/settings-pricing.js');
const { keyActionConfirmation, remoteStatus, renderKeyTable, renderRemoteAgents } = await import('../public/js/wb/settings-access.js');
const { mountLanguageControl, mountThemeControl } = await import('../public/js/wb/settings-ui.js');
const { coreVersion, coreUpgradePrompt, renderBrandVersion, renderCoreUpdate, renderEngineVersion } = await import('../public/js/wb/settings-version.js');

const t = (key, params = {}) => key + (Object.keys(params).length ? ':' + JSON.stringify(params) : '');
const hotTtlMeta = (overrides = {}) => ({ session_hot_ttl: { seconds: 1800, minutes: 30, source: 'config', mode: 'multi', read_only: false,
  environment_set: false, environment_valid: false, min_minutes: 5, max_minutes: 1440, ...overrides } });
function snapshot() {
  return { baselineRuntime: 'claude', hasOlder: true, listKnown: true, instance: { runtimeHealth: { codex: { health: 'auth_failed' }, claude: { health: 'missing' } } },
    overrides: { runtime: [{ sessionGroup: 'a', runtime: 'codex' }], model: [{ sessionGroup: 'b', runtime: 'claude' }] },
    rows: ['origin', 'a', 'b', 'c'].map(sessionGroup => ({ sessionGroup, presence: 'running', name: { displayName: 'Name ' + sessionGroup }, target: { runtime: sessionGroup === 'a' ? 'codex' : 'claude' } })) };
}

function groupPage(items, total = items.length, nextCursor = null) {
  return { items, total, nextCursor, listKnown: true };
}

async function selectEngine(root, runtime) {
  const select = root.querySelector('#settings-engine');
  select.value = runtime;
  await select.dispatch('change');
}

function renderDefaults(root, { snapshot: data = snapshot(), groupCounts, read, ...options }) {
  const rows = data.rows.map(row => ({ ...row, id: row.sessionGroup, displayName: row.name?.displayName, runtime: row.target?.runtime }));
  const followers = rows.filter(row => row.presence === 'running' && !data.overrides?.runtime.find(value => value.sessionGroup === row.id));
  const models = runtime => rows.filter(row => row.presence === 'running' && row.runtime === runtime &&
    !data.overrides?.model.some(value => value.sessionGroup === row.id && value.runtime === runtime));
  const instance = { ...data.instance, default_runtime: data.baselineRuntime };
  return renderDefaultsCard(root, {
    instance,
    groupCounts: groupCounts ?? { followers: data.overrides == null ? null : followers.length, overrides: data.overrides?.runtime.length ?? null,
      models: { claude: models('claude').length, codex: models('codex').length, agy: models('agy').length } },
    read: async path => {
      const url = new URL(path, 'http://fixture');
      if (url.pathname === '/api/groups') {
        const query = url.searchParams;
        if (data.overrides == null) return { ...groupPage([]), listKnown: false };
        const matching = query.has('modelOverridden') ? models(query.get('runtime')) : followers;
        return groupPage(matching.slice(0, Number(query.get('limit'))), matching.length);
      }
      return read?.(path);
    },
    ...options,
  });
}

test('runtime health and interruption confirmation retain unknown and unavailable distinctions', () => {
  const { instance } = snapshot();
  assert.equal(runtimeHealth(instance, 'claude'), 'available');
  assert.equal(runtimeHealth(instance, 'codex'), 'unavailable');
  assert.equal(runtimeHealth({ runtimeHealth: null }, 'codex'), 'unknown');
  const items = Array.from({ length: 5 }, (_, i) => ({ id: 'group:' + i, displayName: 'Group ' + i }));
  const confirmation = runtimeSaveConfirmation('codex', groupPage(items, 8), t);
  assert.match(confirmation, /Group 4/);
  assert.doesNotMatch(confirmation, /Group 5/);
  assert.match(confirmation, /moreGroups.*8/);
  assert.match(runtimeSaveConfirmation('codex', null, t), /cannotList/);
  assert.match(runtimeSaveConfirmation('codex', { ...groupPage(items, 8), listKnown: false }, t), /cannotList/);
});

test('settings opens with filtered totals and invalidates stale opens', async () => {
  const paths = [], loads = [], pending = [];
  const loader = createSettingsLoader({ read: path => {
    paths.push(path); const item = deferred(); pending.push(item); return item.promise;
  }, onLoad: value => loads.push(value) });
  const first = loader.open();
  const expected = [
    'side=running&runtimeOverridden=false', 'runtimeOverridden=true',
    'side=running&runtime=claude&modelOverridden=false', 'side=running&runtime=codex&modelOverridden=false',
    'side=running&runtime=agy&modelOverridden=false',
    'side=running&runtime=claude', 'side=running&runtime=codex',
  ].map(filter => '/api/groups?' + filter + '&limit=1&include=total');
  assert.deepEqual(paths.filter(path => path.startsWith('/api/groups')), expected);
  loader.invalidate();
  pending.forEach(item => item.resolve(groupPage([], 100000)));
  await first;
  assert.equal(loads.length, 0);
  const second = loader.open();
  pending.slice(12).forEach((item, index) => item.resolve(index === 0 ? { default_runtime: 'claude' }
    : { ...groupPage([], index), listKnown: index !== 8 }));
  await second;
  assert.equal(loads.length, 1);
  assert.equal(paths.length, 24);
  assert.equal(loads[0].instance.default_runtime, 'claude');
  assert.deepEqual(loads[0].groupCounts, { followers: 5, overrides: 6, models: { claude: 7, codex: null, agy: 9 }, pricing: { claude: 10, codex: 11 } });
});

test('folded override rows load on demand, reuse previous cursors and recover after a restart', async () => {
  const document = documentFixture(), root = node(document, 'div'), reads = [], opened = [];
  const overrider = n => ({ id: 'group:' + n, displayName: 'Group ' + n, runtime: 'codex' });
  const items = Array.from({ length: 25 }, (_, index) => overrider(index + 1));
  let restarted = false;
  const panel = renderDefaultsCard(root, {
    document, t, groupCounts: { followers: 0, overrides: 25 }, onGroup: id => opened.push(id),
    read: async path => {
      const query = new URL(path, 'http://fixture').searchParams;
      assert.equal(query.get('runtimeOverridden'), 'true');
      assert.equal(query.get('limit'), '8');
      const cursor = query.get('cursor');
      assert.equal(query.get('include'), cursor == null ? 'total' : null);
      reads.push(cursor);
      if (restarted && cursor != null) throw Object.assign(Error('restarted'), { code: 'invalid_cursor' });
      const start = Number(cursor);
      const page = groupPage(items.slice(start, start + 8), 25, start < 24 ? String(start + 8) : null);
      if (cursor != null) delete page.total;
      return page;
    },
  });
  try {
    const details = root.querySelector('.wb-glist'), first = () => details.querySelector('.wb-gl-row').textContent;
    const previous = details.querySelector('.wb-plist-prev'), next = details.querySelector('.wb-plist-next');
    const page = () => details.querySelector('.wb-plist-at').textContent;
    assert.equal(reads.length, 0);
    assert.equal(details.querySelectorAll('.wb-gl-row').length, 0);
    details.open = true; await details.dispatch('toggle');
    assert.equal(details.querySelectorAll('.wb-gl-row').length, 8);
    assert.equal(page(), t('wb.list.page', { page: 1, pages: 4 }));
    await next.dispatch('click'); await tick();
    assert.equal(first(), 'Group 9Codex');
    await next.dispatch('click'); await tick();
    await previous.dispatch('click'); await tick();
    assert.equal(page(), t('wb.list.page', { page: 2, pages: 4 }));
    assert.deepEqual(reads, [null, '8', '16', '8']);
    await next.dispatch('click'); await tick();
    await next.dispatch('click'); await tick();
    assert.equal(details.querySelectorAll('.wb-gl-row').length, 1);
    await details.querySelector('.wb-gl-row').dispatch('click');
    assert.deepEqual(opened, ['group:25']);
    assert.equal(page(), t('wb.list.page', { page: 4, pages: 4 }));
    // The previous-page cursor was issued before Dashboard restarted.
    restarted = true;
    let before = reads.length;
    await previous.dispatch('click'); await tick();
    assert.deepEqual(reads.slice(before), ['16', null]);
    assert.equal(page(), t('wb.list.page', { page: 1, pages: 4 }));
    before = reads.length;
    details.open = false; await details.dispatch('toggle');
    assert.equal(reads.length, before);
    details.open = true; await details.dispatch('toggle');
    assert.deepEqual(reads.slice(before), [null]);
  } finally { panel.destroy(); }
});

test('group search debounces server requests and discards a late response after the query changes', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const document = documentFixture(), root = node(document, 'div'), reads = [], late = deferred();
  const panel = renderDefaultsCard(root, {
    document, t, groupCounts: { followers: 17, overrides: 0 },
    read: async path => {
      const query = new URL(path, 'http://fixture').searchParams;
      reads.push(query.get('q'));
      if (query.get('q') === 'Display') return late.promise;
      if (query.get('q') === 'group:8') return groupPage([{ id: 'group:8', displayName: 'Only by ID' }]);
      return groupPage([], 17);
    },
  });
  try {
    const details = root.querySelector('.wb-glist'), input = details.querySelector('input');
    details.open = true; await details.dispatch('toggle');
    input.value = 'Dis'; await input.dispatch('input');
    context.mock.timers.tick(299); assert.deepEqual(reads, [null]);
    input.value = 'Display'; await input.dispatch('input');
    context.mock.timers.tick(300); assert.deepEqual(reads, [null, 'Display']);
    input.value = 'group:8'; await input.dispatch('input');
    context.mock.timers.tick(300); await tick();
    assert.equal(details.querySelector('.wb-gl-row').children[0].textContent, 'Only by ID');
    late.resolve(groupPage([{ id: 'group:1', displayName: 'Display name' }])); await tick();
    assert.equal(details.querySelector('.wb-gl-row').children[0].textContent, 'Only by ID');
    input.value = 'none'; await input.dispatch('input');
    context.mock.timers.tick(300); await tick();
    assert.equal(details.querySelector('.wb-plist-empty').hidden, false);
    assert.equal(details.querySelectorAll('.wb-gl-row').length, 0);
    assert.deepEqual(reads, [null, 'Display', 'group:8', 'none']);
    input.value = 'group:8'; await input.dispatch('input');
    details.open = false; await details.dispatch('toggle');
    context.mock.timers.tick(300); await tick();
    assert.deepEqual(reads, [null, 'Display', 'group:8', 'none']);
    details.open = true; await details.dispatch('toggle');
    assert.deepEqual(reads, [null, 'Display', 'group:8', 'none', 'group:8']);
  } finally { panel.destroy(); }
});

test('idle reclaim minutes reject invalid drafts and save one confirmed global action', async () => {
  const document = documentFixture(), root = node(document, 'div'), sent = [], asked = [];
  renderHotTtl(root, { metadata: { claude: hotTtlMeta({ mode: 'single' }) }, document, t, confirm: async text => { asked.push(text); return true; },
    execute: async (action, body, options) => { sent.push({ action, body, options }); return true; } });
  const input = root.querySelector('#settings-hot-ttl-minutes'), save = root.querySelector('#settings-save-hot-ttl');
  assert.equal(input.value, '30'); assert.equal(input.min, '5'); assert.equal(input.max, '1440'); assert.equal(input.step, '1');
  assert.equal(input.disabled, false); assert.equal(save.disabled, true);
  for (const value of ['', '4', '1441', '5.5', 'abc']) {
    input.value = value; await input.dispatch('input'); assert.equal(save.disabled, true, value);
    await save.dispatch('click');
  }
  assert.equal(sent.length, 0); assert.equal(asked.length, 0);
  input.value = '5'; await input.dispatch('input'); assert.equal(save.disabled, false); await save.dispatch('click');
  assert.deepEqual(sent, [{ action: 'set-session-hot-ttl', body: { minutes: 5 }, options: { confirmed: true } }]);
  assert.match(asked[0], /hotTtl\.confirm.*"minutes":5/); assert.equal(save.disabled, true);
  assert.equal(root.querySelector('#settings-hot-ttl-result').textContent, 'wb.settings.hotTtl.saved');
  input.value = '1440'; await input.dispatch('input'); assert.equal(save.disabled, false);
});

test('idle reclaim shows exact environment seconds and never writes under environment or mode locks', async () => {
  const document = documentFixture(), root = node(document, 'div'), sent = [];
  for (const overrides of [
    { seconds: 1801, minutes: 1801 / 60, source: 'environment', environment_set: true, environment_valid: true, read_only: true },
    { seconds: 900, minutes: 15, source: 'config', environment_set: true, environment_valid: false, read_only: true },
    { mode: 'single', read_only: true },
    { mode: null, read_only: true },
  ]) {
    renderHotTtl(root, { metadata: { codex: hotTtlMeta(overrides) }, document, t, confirm: async () => true,
      execute: async (...args) => sent.push(args) });
    const input = root.querySelector('#settings-hot-ttl-minutes'), save = root.querySelector('#settings-save-hot-ttl');
    assert.equal(input.disabled, true); assert.equal(input.readOnly, true); assert.equal(save.disabled, true);
    if (overrides.seconds === 1801) {
      assert.equal(input.value, '30.0'); assert.match(root.textContent, /hotTtl\.environment(?!Invalid)/);
      assert.match(root.textContent, /exactSeconds.*1801/);
    }
    if (overrides.environment_valid === false) assert.match(root.textContent, /hotTtl\.environmentInvalid/);
    if (overrides.mode === 'single') assert.match(root.textContent, /hotTtl\.single/);
    input.value = '5'; await input.dispatch('input'); await save.dispatch('click');
  }
  assert.equal(sent.length, 0);
});

test('idle reclaim retains drafts after cancellation or refusal and follows the page write lock', async () => {
  const document = documentFixture(), root = node(document, 'div'), sent = [];
  let writable = true, accepted = false, confirmation = false;
  const locks = [], lock = (node, get) => locks.push(() => { node.disabled = get(); });
  renderHotTtl(root, { metadata: { claude: hotTtlMeta() }, document, t, writable: () => writable, lock,
    confirm: async () => confirmation, execute: async (...args) => { sent.push(args); return accepted; } });
  const input = root.querySelector('#settings-hot-ttl-minutes'), save = root.querySelector('#settings-save-hot-ttl');
  input.value = '5'; await input.dispatch('input'); await save.dispatch('click'); assert.equal(sent.length, 0);
  confirmation = true; await save.dispatch('click'); assert.equal(sent.length, 1); assert.equal(save.disabled, false);
  assert.equal(input.value, '5'); assert.equal(root.querySelector('#settings-hot-ttl-result').textContent, 'wb.settings.saveFailed');
  writable = false; locks.forEach(fn => fn()); assert.equal(input.disabled, true); assert.equal(save.disabled, true);
  await save.dispatch('click'); assert.equal(sent.length, 1);
  writable = true; locks.forEach(fn => fn()); accepted = true; await save.dispatch('click'); assert.equal(save.disabled, true);
});

test('idle reclaim rechecks write and metadata locks after confirmation resolves', async () => {
  for (const change of ['write access', 'read only', 'environment', 'mode']) {
    const document = documentFixture(), root = node(document, 'div'), decision = deferred(), sent = [];
    const meta = hotTtlMeta(); let writable = true, confirmations = 0;
    renderHotTtl(root, { metadata: { claude: meta }, document, t, writable: () => writable,
      confirm: () => { confirmations++; return decision.promise; }, execute: async (...args) => sent.push(args) });
    const input = root.querySelector('#settings-hot-ttl-minutes'), save = root.querySelector('#settings-save-hot-ttl');
    input.value = '5'; await input.dispatch('input');
    const click = save.dispatch('click');
    assert.equal(confirmations, 1);
    if (change === 'write access') writable = false;
    if (change === 'read only') meta.session_hot_ttl.read_only = true;
    if (change === 'environment') meta.session_hot_ttl.environment_set = true;
    if (change === 'mode') meta.session_hot_ttl.mode = null;
    decision.resolve(true); await click;
    assert.equal(sent.length, 0, change + ' changed while the confirmation was open');
  }
});

test('idle reclaim readonly copy omits save instructions and shows a readable exact duration', () => {
  for (const locale of ['en', 'zh']) {
    const pack = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    const translate = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), pack[key] ?? key);
    const document = documentFixture(), root = node(document, 'div');
    renderHotTtl(root, { metadata: { claude: hotTtlMeta({ seconds: 1801, read_only: true, environment_set: true, environment_valid: true }) }, document, t: translate });
    assert.equal(root.querySelector('#settings-hot-ttl-minutes').value, '30.0');
    assert.equal(root.querySelector('#settings-hot-ttl-minutes').disabled, true);
    const range = root.querySelector('#settings-hot-ttl-range').textContent;
    assert.equal(range, pack['wb.settings.hotTtl.readOnly']);
    assert.doesNotMatch(range, /Saving|保存|next reclaim/);
    const source = root.querySelector('#settings-hot-ttl-source').textContent;
    assert.match(source, locale === 'en' ? /30 min 1 sec \(1801 seconds\)/ : /30分1秒（1801秒）/);
    if (locale === 'zh') assert.doesNotMatch(source, /。 /);
    renderHotTtl(root, { metadata: { claude: hotTtlMeta() }, document, t: translate });
    assert.equal(root.querySelector('#settings-hot-ttl-range').textContent, translate('wb.settings.hotTtl.range', { min: 5, max: 1440 }));
  }
});

test('idle reclaim formats legacy fractional minutes without treating the display as a write', async () => {
  const document = documentFixture(), root = node(document, 'div'), sent = [], asked = [];
  renderHotTtl(root, { metadata: { claude: hotTtlMeta({ seconds: 1801, minutes: 1801 / 60 }) }, document, t,
    confirm: async text => { asked.push(text); return true; },
    execute: async (action, body) => { sent.push({ action, body }); return true; } });
  const input = root.querySelector('#settings-hot-ttl-minutes'), save = root.querySelector('#settings-save-hot-ttl');
  assert.equal(input.value, '30.0'); assert.equal(input.disabled, false); assert.equal(save.disabled, true);
  assert.match(root.querySelector('#settings-hot-ttl-source').textContent, /exactSeconds.*"minutes":30.*"remainder":1.*"seconds":1801/);
  await input.dispatch('input'); await save.dispatch('click');
  assert.equal(sent.length, 0); assert.equal(asked.length, 0, 'formatting alone must not ask to save a rounded duration');
  input.value = '31'; await input.dispatch('input'); assert.equal(save.disabled, false);
  await save.dispatch('click');
  assert.equal(sent.length, 1); assert.equal(sent[0].action, 'set-session-hot-ttl'); assert.equal(sent[0].body.minutes, 31);
  assert.equal(save.disabled, true, 'successful save becomes the new unchanged baseline');
  assert.equal(root.querySelector('#settings-hot-ttl-source').textContent, '', 'old fractional duration must not remain after the new integer value is saved');
});

test('idle reclaim missing metadata stays unknown and does not reuse the prior instance value', () => {
  const document = documentFixture(), root = node(document, 'div');
  renderHotTtl(root, { metadata: { claude: hotTtlMeta() }, document, t });
  renderHotTtl(root, { metadata: {}, document, t });
  assert.equal(root.querySelector('#settings-hot-ttl-minutes').value, '');
  assert.equal(root.querySelector('#settings-hot-ttl-minutes').disabled, true);
  assert.equal(root.querySelector('#settings-hot-ttl-source').textContent, 'wb.unknown');
});

test('each engine choice carries its own sign-in state, and group lines with a count of zero are left out', async () => {
  const document = documentFixture(), root = document.createElement('div');
  const quiet = { ...snapshot(), rows: snapshot().rows.map(row => ({ ...row, presence: 'not_running' })) };
  renderDefaults(root, { confirm: async () => true, snapshot: quiet, groupCounts: { followers: 0, overrides: 0 }, metadata: {}, document, t, read: async () => ({}), execute: async () => true });
  const [claude, codex, agy] = root.querySelector('#settings-engine').children;
  assert.equal(claude.textContent, 'Claude · wb.settings.health.available · wb.settings.defaultEngineBadge');
  assert.equal(codex.textContent, 'Codex · wb.settings.health.unavailable');
  assert.equal(agy.textContent, 'Antigravity · wb.settings.health.unknown');
  await selectEngine(root, 'agy');
  assert.equal(root.querySelector('.wb-set-split').hidden, false);
  const counts = root.querySelectorAll('.wb-gsum');
  assert.ok(counts.every(count => count.parentElement.hidden), 'both zero-count lines are hidden');
  assert.equal(root.querySelector('.wb-glist'), null);

  const busy = document.createElement('div');
  renderDefaults(busy, { confirm: async () => true, snapshot: snapshot(), groupCounts: { followers: 3, overrides: 2 }, metadata: {}, document, t, read: async () => ({}), execute: async () => true });
  await selectEngine(busy, 'agy');
  const lines = busy.querySelectorAll('.wb-gsum').filter(line => !line.parentElement.hidden).map(line => line.textContent);
  assert.deepEqual(lines, ['wb.settings.followers:{"count":3}', 'wb.settings.overrides:{"count":2}'], 'counts above zero keep their lines');
});

test('when default engine followers cannot be listed, their count stays unknown and saving requires confirmation', async () => {
  const document = documentFixture(), root = document.createElement('div');
  const unlisted = { ...snapshot(), overrides: null, instance: { runtimeHealth: { codex: { health: 'ok' } } } };
  const confirmations = [];
  const panel = renderDefaults(root, { confirm: async question => { confirmations.push(question); return false; },
    snapshot: unlisted, metadata: {}, document, t, read: async () => ({}),
    execute: async () => assert.fail('Declining confirmation must prevent the engine switch') });
  const follower = root.querySelectorAll('.wb-gsum').find(line => line.textContent.startsWith('wb.settings.followers'));
  assert.ok(follower, 'the follower line is rendered');
  assert.equal(follower.textContent, 'wb.settings.followers:{"count":"wb.unknown"}');
  assert.equal(follower.parentElement.hidden, false, 'an unknown count is not hidden like a zero');
  assert.equal(follower.parentElement.querySelectorAll('.wb-note').length, 1, 'the read failure is said under it');
  await selectEngine(root, 'codex');
  await root.querySelector('#settings-set-default').dispatch('click');
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /wb\.settings\.cannotList/);
  panel.destroy();
});

test('default engine keeps the sign-in gate and model and effort save together per engine', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const meta = runtime => ({ runtime, current_model: 'one', current_effort: 'high', models: [{ id: 'one' }, { id: 'two' }], efforts_by_model: { one: ['high'], two: ['low'] } });
  const panel = renderDefaults(root, { confirm: async () => true, snapshot: snapshot(), metadata: { claude: meta('claude'), codex: meta('codex') }, document, t, read: async () => ({}), execute: async (action, body) => { calls.push({ action, body }); return true; } });
  await selectEngine(root, 'codex');
  assert.equal(root.querySelector('#settings-engine').disabled, false);
  assert.equal(root.querySelector('#settings-set-default').disabled, true);
  assert.equal(root.querySelectorAll('.wb-note').find(note => note.textContent === 'wb.settings.runtimeNote').hidden, false);
  assert.equal(root.querySelector('.wb-set-split').hidden, true);
  const save = root.querySelector('#settings-save-models');
  assert.equal(save.disabled, true, 'nothing to save yet'); assert.equal(save.hidden, true);
  const model = root.querySelector('#settings-model-codex'); model.value = 'two'; await model.dispatch('change');
  const effort = root.querySelector('#settings-effort-codex'); assert.equal(effort.value, '', 'the old effort is not offered by the new model');
  effort.value = 'low'; await effort.dispatch('change'); assert.equal(save.disabled, false);
  await save.dispatch('click');
  assert.deepEqual(calls, [{ action: 'switch-model', body: { runtime: 'codex', model: 'two', confirmed: true } }, { action: 'switch-effort', body: { runtime: 'codex', effort: 'low' } }]);
  assert.equal(save.hidden, true, 'saved values become the new baseline');
  model.value = '__custom__'; await model.dispatch('change'); const custom = root.querySelector('#settings-model-custom-codex');
  assert.equal(custom.hidden, false); custom.value = 'unknown'; await custom.dispatch('input'); assert.equal(effort.disabled, true);
  panel.destroy();
});

test('selecting an engine is separate from setting the default and checking installation', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const healthy = { ...snapshot(), instance: { runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'ok' }, agy: { health: 'ok' } },
    versions: { codex: { installed: null }, agy: { installed: null } } } };
  const confirmations = [];
  healthy.rows[0].run = { runId: 'run-origin' };
  let rejection = "Fixture credentials were rejected";
  const detailReads = [];
  let recheckError = true, rechecks = 0;
  const panel = renderDefaults(root, { confirm: async text => { confirmations.push(text); return true; }, snapshot: healthy, document, t,
    recheck: async () => { rechecks++; if (recheckError) throw new Error('x'); },
    read: async path => {
    if (path === '/api/instance') return { versions: { codex: { installed: null }, agy: { installed: '1.5.11' } } };
    detailReads.push(path);
    if (path === '/api/groups/chat%3Amissing') return { displayName: 'Name outside preview' };
    throw Error('missing detail');
  }, execute: async (action, body) => { calls.push({ action, body });
    if (rejection) throw new Error(rejection);
    return { ok: true, data: { baseline: body.runtime, groups: [
      { sessionGroup: 'origin', restart: { status: 'not_restarted', reason: 'fence_conflict' } },
      { sessionGroup: 'c', restart: { status: 'unknown', reason: 'no_reply' } },
      { sessionGroup: 'chat:missing', restart: { status: 'unknown', reason: 'no_reply' } },
      { sessionGroup: 'chat:gone', restart: { status: 'unknown', reason: 'no_reply' } },
      { sessionGroup: 'chat:ok', restart: { status: 'accepted' } },
    ] }, messageKey: 'result.runtime_saved', messageParams: { value: body.runtime } }; } });
  const save = root.querySelector('#settings-set-default');
  const select = root.querySelector('#settings-engine');
  const badge = root.querySelector('.wb-default-badge');
  const split = root.querySelector('.wb-set-split');
  assert.equal(select.value, 'claude');
  assert.equal(save.hidden, true);
  assert.equal(badge.hidden, false);
  assert.equal(split.hidden, true);
  await selectEngine(root, 'codex');
  assert.equal(save.hidden, false);
  assert.equal(save.disabled, false, 'an absent Codex version does not block setting it as default');
  assert.equal(split.hidden, false);
  assert.equal(calls.length, 0);
  await selectEngine(root, 'claude');
  assert.equal(save.hidden, true);
  assert.equal(badge.hidden, false);
  assert.equal(calls.length, 0);
  await selectEngine(root, 'agy');
  const install = root.querySelector('.wb-note-act');
  assert.equal(save.disabled, true);
  assert.equal(install.hidden, false);
  assert.equal(root.querySelector('#settings-threshold-agy'), null);
  assert.equal(root.querySelector('#settings-save-models').hidden, true);
  assert.match(install.textContent, /wb\.runtimeNotFound:\{"runtime":"Antigravity","command":"zylos runtime agy"\}/);
  assert.equal(split.hidden, true);
  const recheck = install.querySelector('button');
  await recheck.dispatch('click');
  assert.equal(install.hidden, false);
  assert.equal(save.disabled, true);
  assert.equal(root.querySelector('#settings-engine-result').textContent, 'status.failed:{"error":"x"}');
  recheckError = false;
  await Promise.all([recheck.dispatch('click'), recheck.dispatch('click')]);
  assert.equal(rechecks, 2, 'a second click during the successful check sends nothing');
  assert.equal(install.hidden, true);
  assert.equal(save.disabled, false);
  assert.equal(root.querySelector('#settings-engine-result').textContent, '');
  await selectEngine(root, 'codex');
  await save.dispatch('click');
  assert.match(root.textContent, /Fixture credentials were rejected/);
  assert.equal(save.hidden, false, 'a failed switch keeps the candidate available to retry');
  rejection = null;
  await save.dispatch('click');
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ action: 'switch-runtime', body: { runtime: 'codex', confirmed: true } })));
  assert.match(root.textContent, /result\.runtime_saved:\{"value":"Codex"\}/);
  const feedback = root.querySelector('#settings-engine-result').textContent;
  assert.match(feedback, /savedRestartFailed.*Name origin.*fence_conflict/);
  assert.match(feedback, /savedRestartUnknown.*Name c.*no_reply/);
  assert.match(feedback, /savedRestartUnknown.*Name outside preview.*no_reply/);
  assert.match(feedback, /savedRestartUnknown.*chat:gone.*no_reply/);
  assert.deepEqual(detailReads, ['/api/groups/chat%3Amissing', '/api/groups/chat%3Agone']);
  assert.equal(save.hidden, true, 'successful save updates the baseline in the mounted card');
  assert.equal(badge.hidden, false);
  assert.equal(split.hidden, true);
  assert.match(select.children[1].textContent, / · wb\.settings\.defaultEngineBadge$/);
  assert.doesNotMatch(select.children[0].textContent, /defaultEngineBadge/);
  await selectEngine(root, 'claude');
  await save.dispatch('click');
  assert.match(confirmations.at(-1), /^confirm\.switch_runtime:\{"value":"Claude"\}/);
  assert.match(root.textContent, /result\.runtime_saved:\{"value":"Claude"\}/);
  panel.destroy();
});

const effortMeta = runtime => ({ runtime, current_model: 'one', current_effort: 'high', models: [{ id: 'one' }, { id: 'two' }], efforts_by_model: { one: ['high'], two: ['low', 'minimal'] } });

test('the mounted default effort uses configured metadata and only saves a user change', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [], questions = [];
  const data = snapshot();
  data.rows[0] = { ...data.rows[0], runtimeInfo: { effort: 'high', model: 'one' }, effective: { runtime: 'claude', effort: 'high' } };
  const meta = { runtime: 'claude', current_model: 'one', current_effort: 'low', models: [{ id: 'one' }], efforts_by_model: { one: ['low', 'high'] } };
  const panel = renderDefaults(root, { snapshot: data, metadata: { claude: meta }, document, t,
    confirm: async question => { questions.push(question); return true; }, read: async () => ({}),
    execute: async (action, body) => { calls.push({ action, body }); return true; } });
  try {
    const effort = root.querySelector('#settings-effort-claude'), save = root.querySelector('#settings-save-models');
    assert.equal(effort.value, 'low', 'the running Origin high effort is not the configured default');
    assert.equal(save.hidden, true); assert.equal(save.disabled, true);
    await save.dispatch('click');
    assert.deepEqual(calls, []); assert.deepEqual(questions, []);
    effort.value = 'low'; await effort.dispatch('change'); await save.dispatch('click');
    assert.deepEqual(calls, [], 'reselecting the configured value is not a change');
    effort.value = 'high'; await effort.dispatch('change');
    assert.equal(save.hidden, false); assert.equal(save.disabled, false);
    await save.dispatch('click');
    assert.deepEqual(calls, [{ action: 'switch-effort', body: { runtime: 'claude', effort: 'high' } }]);
    assert.deepEqual(questions[0].split('\n').map(line => line.split(':')[0]),
      ['wb.settings.confirmModels', 'wb.settings.effortNextStart', 'wb.settings.changeEffort']);
    assert.equal(questions.length, 1); assert.equal(save.hidden, true);
    assert.equal(root.querySelector('#settings-model-result').textContent, 'wb.settings.defaultsSaved wb.settings.effortNextStart');
  } finally { panel.destroy(); }
});
async function draftEngine(root, runtime) {
  await selectEngine(root, runtime);
  const model = root.querySelector('#settings-model-' + runtime); model.value = 'two'; await model.dispatch('change');
  const effort = root.querySelector('#settings-effort-' + runtime); effort.value = runtime === 'codex' ? 'minimal' : 'low'; await effort.dispatch('change');
}

async function draftBothEngines(root) {
  for (const runtime of ['claude', 'codex']) await draftEngine(root, runtime);
}

test('saving model and effort confirms and writes only the selected engine', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [], asked = [];
  const tr = (key, params) => key === 'effort.minimal' ? 'Minimal' : t(key, params);
  const claude = { ...effortMeta('claude'), model_thresholds: { one: 70, two: 70 }, model_threshold_max: { two: 95 } };
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude, codex: effortMeta('codex') }, document, t: tr, read: async () => ({}),
    confirm: async text => { asked.push(text); return true; }, execute: async (action, body, options) => { calls.push({ action, body, options }); return true; } });
  await draftEngine(root, 'claude');
  const threshold = root.querySelector('#settings-threshold-claude');
  threshold.value = '96';
  await threshold.dispatch('input');
  await draftEngine(root, 'codex');
  const save = root.querySelector('#settings-save-models');
  assert.equal(save.disabled, false, 'an invalid threshold on Claude does not block saving Codex');
  await save.dispatch('click');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Name a/, 'the explicit engine still inherits its default model');
  assert.match(asked[0], /Minimal/);
  assert.doesNotMatch(asked[0], /effort\.minimal|Name origin|Name c|Name b|"runtime":"Claude"/);
  assert.deepEqual(calls.map(({ action, body }) => [action, body.runtime]), [['switch-model', 'codex'], ['switch-effort', 'codex']]);
  assert.equal(root.querySelector('#settings-save-models').hidden, true);
  await selectEngine(root, 'claude');
  assert.equal(root.querySelector('#settings-model-claude').closest('.wb-pref-c').querySelector('.wb-dirty').hidden, false);
  assert.equal(root.querySelector('#settings-model-result').textContent, '');
  threshold.value = '70';
  await threshold.dispatch('input');
  await root.querySelector('#settings-save-models').dispatch('click');
  assert.equal(asked.length, 2);
  assert.match(asked[1], /Name origin.*\nName c/);
  assert.doesNotMatch(asked[1], /Name b|"runtime":"Codex"/);
  assert.deepEqual(calls.slice(2).map(({ action, body }) => [action, body.runtime]), [['switch-model', 'claude'], ['switch-effort', 'claude']]);
  assert.ok(calls.every(call => call.options?.confirmed === true), 'no action asks again');
  assert.equal(root.querySelector('#settings-save-models').hidden, true);
  assert.equal(modelSaveConfirmation([{ runtime: 'claude', key: 'effort', value: 'max' }], tr).split('\n').length, 2);
  assert.match(modelSaveConfirmation([{ runtime: 'codex', key: 'model', value: 'two' }], (key, params) => params ? params.value : key, { codex: { models: [{ id: 'two', display_name: 'Two Pro' }] } }), /Two Pro/, 'models are named as the dropdown shows them'); panel.destroy();
});

test('saving an engine or model with no running followers skips confirmation', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const data = snapshot();
  data.rows = data.rows.filter(row => row.sessionGroup === 'a');
  data.instance.runtimeHealth.codex.health = 'ok';
  const panel = renderDefaults(root, { document, snapshot: data, metadata: { claude: effortMeta('claude') }, t, read: async () => ({}),
    confirm: async () => assert.fail('the only running session has a runtime override'),
    execute: async (action, body) => { calls.push({ action, body }); return true; } });
  await selectEngine(root, 'codex');
  await root.querySelector('#settings-set-default').dispatch('click');
  assert.deepEqual(calls, [{ action: 'switch-runtime', body: { runtime: 'codex' } }]);
  await selectEngine(root, 'claude');
  const model = root.querySelector('#settings-model-claude');
  model.value = 'two'; await model.dispatch('change');
  await root.querySelector('#settings-save-models').dispatch('click');
  assert.deepEqual(calls.at(-1), { action: 'switch-model', body: { runtime: 'claude', model: 'two' } });
  panel.destroy();
});

test('a defaults card wired without a confirmation runs no change', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const healthy = { ...snapshot(), instance: { runtimeHealth: { codex: { health: 'ok' }, claude: { health: 'ok' } } } };
  const panel = renderDefaults(root, { snapshot: healthy, metadata: { claude: effortMeta('claude'), codex: effortMeta('codex') }, document, t,
    read: async () => ({}), execute: async (action, body) => { calls.push({ action, body }); return true; } });
  await selectEngine(root, 'codex');
  const saveRuntime = root.querySelector('#settings-set-default'); assert.equal(saveRuntime.disabled, false);
  await saveRuntime.dispatch('click');
  await draftBothEngines(root);
  const saveModels = root.querySelector('#settings-save-models'); assert.equal(saveModels.disabled, false);
  await saveModels.dispatch('click');
  assert.deepEqual(calls, []);
  panel.destroy();
});

test('the effort dropdown names each level the way the confirmation does', () => {
  const document = documentFixture(), root = document.createElement('div');
  const names = { 'effort.high': '高', 'effort.low': '低', 'effort.minimal': '极低' };
  const tr = (key, params) => names[key] ?? t(key, params);
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude: effortMeta('claude'), codex: effortMeta('codex') }, document, t: tr, read: async () => ({}) });
  const codex = root.querySelector('#settings-effort-codex');
  assert.deepEqual(codex.children.map(option => [option.value, option.textContent]), [['high', '高']]);
  const model = root.querySelector('#settings-model-codex'); model.value = 'two'; model.dispatch('change');
  assert.deepEqual(root.querySelector('#settings-effort-codex').children.map(option => option.textContent), ['actions.effort_unavailable:{"value":"高"}', '低', '极低'], 'even the unavailable current level is named');
  assert.match(modelSaveConfirmation([{ runtime: 'codex', key: 'effort', value: 'minimal' }], tr), /极低/);
  panel.destroy();
});

test('cancelling the model confirmation sends nothing and shows no result', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude: effortMeta('claude'), codex: effortMeta('codex') }, document, t, read: async () => ({}),
    confirm: async () => false, execute: async (action, body) => { calls.push({ action, body }); return true; } });
  await draftBothEngines(root);
  const save = root.querySelector('#settings-save-models'), before = root.textContent;
  await save.dispatch('click');
  assert.equal(calls.length, 0); assert.equal(save.hidden, false, 'the drafts stay'); assert.equal(root.textContent, before, 'no result line appears');
  assert.doesNotMatch(root.textContent, /wb\.settings\.(saveFailed|defaultsSaved|partlySaved)/); panel.destroy();
});

test('a model save that fails part way names what took effect and what did not', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude: effortMeta('claude'), codex: effortMeta('codex') }, document,
    t: (key, params) => params ? key + JSON.stringify(params) : key, read: async () => ({}),
    confirm: async () => true, execute: async (action, body) => { calls.push({ action, body }); return calls.length < 2; } });
  const model = root.querySelector('#settings-model-claude');
  model.value = 'two'; await model.dispatch('change');
  const effort = root.querySelector('#settings-effort-claude');
  effort.value = 'low'; await effort.dispatch('change');
  await root.querySelector('#settings-save-models').dispatch('click');
  assert.equal(calls.length, 2, 'stops at the first failure');
  const text = root.textContent;
  assert.match(text, /wb\.settings\.partlySaved/);
  assert.match(text, /"done":"wb\.settings\.changeModel\{\\"runtime\\":\\"Claude\\",\\"value\\":\\"two\\"\}"/);
  assert.match(text, /"left":"wb\.settings\.changeEffort/);
  assert.equal(root.querySelector('#settings-save-models').hidden, false, 'what did not apply is still a draft'); panel.destroy();
});
function priceFixture() {
  const document = documentFixture(), root = document.createElement('div'), host = root;
  for (const id of ['settings-model-pricing-group', 'settings-priority-pricing-group', 'settings-fast-mode-group']) root.append(node(document, 'div', id));
  const base = node(document, 'tbody', 'settings-price-rows'), priority = node(document, 'tbody', 'settings-priority-price-rows');
  root.querySelector('#settings-model-pricing-group').append(base); root.querySelector('#settings-priority-pricing-group').append(priority);
  root.querySelector('#settings-fast-mode-group').append(node(document, 'input', 'settings-fast-multiplier'));
  for (const id of ['settings-status', 'settings-save', 'settings-add-model', 'settings-add-priority-model']) root.append(node(document, 'button', id));
  const rate = { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 1 };
  const data = { active: 'claude', runtimes: { claude: { builtInModels: ['base', 'unused'], modelPrices: { base: { ...rate, fastModeMultiplier: 3, longContext: { input: 2 } }, unused: rate, custom: rate }, fastMode: { mode: 'multiplier', configuredMultiplier: 6 } }, codex: { builtInModels: ['gpt'], modelPrices: { gpt: rate }, priorityModelPrices: { gpt: rate }, builtInPriorityModels: ['gpt'], fastMode: { mode: 'service_tier' } } } };
  return { document, root, host, base, priority, data, rate };
}

test('two pricing tabs list every price row and keep custom deletion, premium rates and explicit multiplier reset in one save', async () => {
  const fixture = priceFixture(), writes = [];
  const panel = createPricingPanel({ ...fixture, data: fixture.data, groupCounts: { claude: 3, codex: 1 }, usage: { models: [{ runtime: 'claude', model: 'base-1', cost: 3 }] }, t, write: async body => writes.push(body) });
  assert.deepEqual(fixture.base.children.map(row => row.dataset.prefix), ['base', 'unused', 'custom']);
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
  const panel = createPricingPanel({ ...fixture, usage: { models: [], unmatched: [{ runtime: 'codex', model: 'gpt-reserve', tokens: 1400000 }] }, t, formatTokens: value => (value / 1e6).toFixed(1) + 'M', write: async body => writes.push(body) });
  assert.match(fixture.root.textContent, /1\.4M/);
  const add = fixture.root.querySelectorAll('button').find(button => button.textContent === 'wb.settings.addPrice'); await add.dispatch('click');
  assert.equal(panel.runtime(), 'codex'); assert.ok(fixture.base.children.some(row => row.dataset.prefix === 'gpt-reserve'));
  appendPriceRow(fixture.base, '', fixture.rate, false, fixture); await panel.save(); assert.equal(writes.length, 0); assert.equal(fixture.root.querySelector('#settings-status').textContent, 'model_prefix_required'); panel.destroy();
});

test('price row validation rejects duplicate, blank and nonnumeric prices without discarding premium fields', () => {
  const fixture = priceFixture(); appendPriceRow(fixture.base, 'x', fixture.rate, false, fixture); appendPriceRow(fixture.base, 'x', fixture.rate, false, fixture);
  assert.throws(() => collectPriceRows(fixture.base.children), /duplicate_model_prefix/); fixture.base.children[1].remove();
  fixture.base.children[0].querySelectorAll('input')[1].value = ''; assert.throws(() => collectPriceRows(fixture.base.children), /invalid_model_price/);
});

test('price rows list the most used in the last 7 days first, by the longest matching prefix, then the saved order', () => {
  const prices = { modelPrices: { gpt: {}, unused: {}, 'gpt-x': {}, custom: {} } };
  assert.deepEqual(orderedPricePrefixes(prices, [{ model: 'gpt-x-1', cost: 2 }, { model: 'gpt-4', cost: 1 }, { model: 'gpt-x-2', cost: 0.5 }]), ['gpt-x', 'gpt', 'unused', 'custom']);
  assert.deepEqual(orderedPricePrefixes(prices, []), ['gpt', 'unused', 'gpt-x', 'custom'], 'with no use the saved order stays');
});

test('settings composition moves actual control nodes into cards grouped by who they affect and preserves their listeners', async () => {
  const document = documentFixture(), root = document.createElement('div'), settings = document.createElement('div'), fleet = document.createElement('div'), actions = document.createElement('div');
  let movedCalls = 0;
  for (const [source, tag, id] of [[settings, 'section', 'settings-model-pricing-group'], [settings, 'section', 'observer-settings-group'], [actions, 'section', 'action-status']]) { const control = node(document, tag, id); source.append(control); control.addEventListener('click', () => movedCalls++); }
  const modeField = node(document, 'div'); modeField.className = 'action-field'; const mode = node(document, 'select', 'action-mode'); modeField.append(mode); actions.append(modeField); let calls = 0; mode.addEventListener('change', () => calls++);
  const priceInput = node(document, 'input', 'price-input'); settings.querySelector('#settings-model-pricing-group').append(priceInput);
  for (const name of ['fleet', 'keys']) { const panel = node(document, 'section'); panel.className = 'manage-panel'; panel.dataset.panel = name; panel.hidden = true; panel.addEventListener('click', () => movedCalls++); fleet.append(panel); }
  const selfCard = node(document, 'div', 'fleet-self-card'); fleet.querySelector('.manage-panel[data-panel="fleet"]').append(selfCard, node(document, 'div', 'fleet-agent-list'));
  const address = node(document, 'div', 'settings-address-card'); fleet.querySelector('.manage-panel[data-panel="keys"]').append(address);
  const logout = node(document, 'button', 'logout-btn'), detailLabel = node(document, 'label'); detailLabel.append(node(document, 'input', 'wb-detail-toggle'));
  const page = composeSettings(root, { settings, fleet, actions, controls: [detailLabel, logout], document, t });
  assert.deepEqual(settingsSections, ['account', 'general', 'machine', 'fleet', 'defaults', 'pricing']);
  assert.equal(root.querySelector('#action-mode'), mode); await mode.dispatch('change'); assert.equal(calls, 1);
  // Each section starts with its own heading and lead; content follows them (no prepend ahead of the title).
  for (const name of settingsSections) { assert.equal(page.sections[name].children[0].querySelector('h2').tagName, 'H2'); assert.equal(page.sections[name].children[1].className, 'wb-set-lead'); }
  // The page opens on the account section: sign out, then the conversation access slot, then the keys.
  assert.equal(page.sections.account.hidden, false);
  assert.equal(page.sections.account.querySelector('#logout-btn'), logout);
  assert.equal(page.sections.account.children[3], page.slots.chat);
  assert.equal(page.sections.account.querySelector('.manage-panel').dataset.panel, 'keys'); assert.equal(page.sections.account.querySelector('.manage-panel').hidden, false);
  assert.equal(page.prefs.detail.querySelector('#wb-detail-toggle').parentElement, detailLabel); assert.ok(page.sections.general.querySelector('[data-pref="detail"]'));
  // The whole machine: version, time zone, terminal observer, session mode (with idle reclaim in it), session hosts.
  const machine = page.sections.machine.children.slice(2);
  assert.deepEqual(machine.map(child => child.id), ['settings-zylos-version', 'settings-machine-timezone', 'observer-settings-group', 'settings-session-mode', 'settings-machine-hosts']);
  assert.equal(page.slots.version.closest('#settings-zylos-version'), machine[0]);
  assert.equal(mode.closest('#settings-session-mode'), machine[3]); assert.equal(page.slots.idleReclaim.closest('#settings-session-mode'), machine[3]);
  assert.match(machine[3].textContent, /wb\.settings\.session\.multi.*wb\.settings\.session\.multiNote.*wb\.settings\.session\.single.*wb\.settings\.session\.singleNote/, 'the two modes are explained once, in plain words');
  // Other machines: the address other machines use to add this one sits under this machine's name.
  const fleetPanel = page.sections.fleet.querySelector('.manage-panel');
  assert.equal(fleetPanel.hidden, false); assert.equal(fleetPanel.children[0], selfCard); assert.equal(fleetPanel.children[1], address);
  assert.equal(page.sections.defaults.children[2].id, 'settings-defaults');
  assert.equal(priceInput.closest('#settings-section-pricing'), page.sections.pricing);
  page.select('pricing'); assert.equal(page.sections.pricing.hidden, false); assert.equal(page.sections.account.hidden, true);
  page.select('keys'); assert.equal(page.sections.account.hidden, false, 'an unknown section opens the account section');
  const actionBody = page.actionsScope.querySelector('.modal-body');
  assert.equal(mode.closest('.modal-body'), actionBody);
  assert.equal(root.querySelector('#action-threshold'), null);
  assert.deepEqual(actionBody.querySelectorAll('button, select, input'), [mode]);
  assert.equal(priceInput.closest('.modal-body'), null);
  const pricingBadge = root.querySelector('nav').querySelectorAll('.wb-set-nav-n')[settingsSections.indexOf('pricing')];
  page.badge('pricing', 2); assert.equal(pricingBadge.textContent, '2'); assert.equal(pricingBadge.hidden, false);
  page.badge('pricing', 0); assert.equal(pricingBadge.hidden, true);
  await page.sections.machine.querySelector('#observer-settings-group').dispatch('click');
  await page.sections.fleet.querySelector('.manage-panel').dispatch('click');
  await page.sections.account.querySelector('.manage-panel').dispatch('click'); assert.equal(movedCalls, 3);
});

test('a finished key or machine notice clears when another settings section opens; one still running stays', () => {
  const document = documentFixture(), root = document.createElement('div');
  const settings = document.createElement('div'), fleet = document.createElement('div'), actions = document.createElement('div');
  const notice = node(document, 'div', 'fleet-manage-status'); fleet.append(notice);
  const page = composeSettings(root, { settings, fleet, actions, document, t });
  page.select('account');
  Object.assign(notice, { textContent: 'fleet_manage.key_revoked_status', className: 'wb-note wb-status-success', hidden: false });
  page.select('account');
  assert.equal(notice.textContent, 'fleet_manage.key_revoked_status', 'staying on the same section keeps it');
  page.select('defaults');
  assert.equal(notice.textContent, ''); assert.equal(notice.hidden, true);
  Object.assign(notice, { textContent: 'fleet_manage.revoking_key', className: 'wb-note wb-status-running', hidden: false });
  page.select('account');
  assert.equal(notice.textContent, 'fleet_manage.revoking_key'); assert.equal(notice.hidden, false);
});

test('settings relabel updates navigation without replacing controls or changing the selected section', async () => {
  const document = documentFixture(), root = document.createElement('div');
  const settings = document.createElement('div'), fleet = document.createElement('div'), actions = document.createElement('div');
  const logout = node(document, 'button', 'logout-btn');
  let locale = 'en', calls = 0;
  logout.addEventListener('click', () => calls++);
  const page = composeSettings(root, { settings, fleet, actions, controls: [logout], document, t: key => locale + ':' + key });
  page.select('general');
  const nav = root.querySelector('nav'), buttons = nav.querySelectorAll('[data-settings-section]');
  const headings = settingsSections.map(name => page.sections[name].querySelector('h2'));
  for (const nextLocale of ['zh', 'en']) {
    locale = nextLocale;
    page.relabel();
    assert.equal(root.querySelector('nav'), nav);
    assert.equal(nav.getAttribute('aria-label'), locale + ':wb.settings');
    for (const [index, name] of settingsSections.entries()) {
      const button = nav.querySelectorAll('[data-settings-section]')[index];
      assert.equal(button, buttons[index]);
      assert.equal(button.querySelector('.wb-set-nav-copy').children[0].textContent, locale + ':wb.settings.section.' + name);
      assert.equal(button.querySelector('.wb-set-nav-summary').textContent, locale + ':wb.settings.summary.' + name);
      assert.equal(page.sections[name].querySelector('.wb-set-back').getAttribute('aria-label'), locale + ':wb.settings.backToSections');
      assert.equal(button.getAttribute('aria-current'), String(name === 'general'));
      assert.equal(page.sections[name].querySelector('h2'), headings[index]);
      assert.equal(headings[index].textContent, locale + ':wb.settings.section.' + name);
      assert.equal(page.sections[name].hidden, name !== 'general');
    }
    assert.equal(page.sections.account.querySelector('#logout-btn'), logout);
    await logout.dispatch('click');
  }
  assert.equal(calls, 2);
  await buttons[settingsSections.indexOf('pricing')].dispatch('click');
  assert.equal(page.sections.pricing.hidden, false);
  assert.equal(page.sections.general.hidden, true);
});

test('the engine version shows the chosen engine CLI and reuses the upgrade control, with the read-only reason', async () => {
  const document = documentFixture(), root = document.createElement('div'), upgrade = node(document, 'button'); upgrade.append(node(document, 'span', 'action-cli-label'), node(document, 'span', 'action-cc-ver')); let called = 0; upgrade.addEventListener('click', () => called++);
  renderEngineVersion(root, { codex: { installed: '1', update: '2' }, claude: { installed: '9' } }, { document, upgrade, t, runtime: 'codex', readOnly: true });
  assert.match(root.textContent, /Codex · v1 ↑2/); assert.doesNotMatch(root.textContent, /v9/, 'only the chosen engine');
  assert.equal(root.querySelector('button'), upgrade); assert.equal(upgrade.querySelector('#action-cli-label').textContent, 'actions.upgrade_runtime:{"runtime":"Codex"}');
  assert.equal(upgrade.querySelector('#action-cc-ver').classList.contains('action-ver-dot'), true, 'a newer CLI marks the button');
  assert.equal(upgrade.disabled, true); assert.equal(upgrade.title, 'remote.actions_read_only_tooltip');
  renderEngineVersion(root, { codex: { installed: '1' }, claude: { installed: '9' } }, { document, upgrade, t, runtime: 'claude', readOnly: false });
  assert.match(root.textContent, /Claude · v9/); assert.equal(upgrade.querySelector('#action-cli-label').textContent, 'actions.upgrade_runtime:{"runtime":"Claude"}');
  assert.equal(upgrade.querySelector('#action-cc-ver').classList.contains('action-ver-dot'), false);
  await upgrade.dispatch('click'); assert.equal(called, 1); assert.equal(upgrade.disabled, false);
  renderEngineVersion(root, {}, { document, t, runtime: 'codex' }); assert.match(root.textContent, /Codex · wb\.unknown/); assert.equal(root.querySelector('button'), null);
});

test('theme and language are segmented choices that forward the pressed value', async () => {
  const document = documentFixture(), root = document.createElement('div'); let value, locale;
  const theme = mountThemeControl(root, { document, t, value: 'system', onChange: next => value = next });
  assert.deepEqual(theme.children.map(button => button.dataset.value), ['system', 'light', 'dark']);
  assert.equal(theme.children[0].getAttribute('aria-pressed'), 'true');
  await theme.children[2].dispatch('click'); assert.equal(value, 'dark'); assert.equal(theme.children[2].getAttribute('aria-pressed'), 'true'); assert.equal(theme.children[0].getAttribute('aria-pressed'), 'false');
  const language = mountLanguageControl(root, { document, t, value: 'zh', onChange: next => locale = next });
  assert.equal(language.id, 'locale-toggle'); assert.deepEqual(language.children.map(button => button.textContent), ['中文', 'English']);
  await language.children[1].dispatch('click'); assert.equal(locale, 'en');
});

test('removed header entry selectors have no startup bindings and account controls live on the settings page', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const selector of ['info-bar', 'actions-btn', 'settings-btn', 'zylos-update-hint', 'info-bar-update', 'info-bar-text', 'info-bar-buttons']) {
    assert.doesNotMatch(app, new RegExp('(?<![\\w-])' + selector + '(?![\\w-])'), 'obsolete selector ' + selector);
    assert.equal(html.includes('id="' + selector + '"'), false, 'obsolete node ' + selector);
  }
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  for (const id of ['fleet-sound-toggle', 'logout-btn', 'wb-detail-toggle']) { assert.equal(header.includes('id="' + id + '"'), false); assert.ok(html.indexOf('id="' + id + '"') > html.indexOf('id="tab-settings"')); }
  assert.equal(html.includes('id="locale-toggle"'), false, 'the language choice is built inside the settings page');
  assert.match(app, /initSettingsPage\(\);\s*initTabs\(\)/); assert.match(html, /app\.js/); assert.match(html, /style\.css/);
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.zh.json', import.meta.url))), en = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
  const englishFragments = new Set(['chat.delete.messages', 'chat.delete.attachments']);
  for (const key of Object.keys(en)) {
    if (key.endsWith('One')) assert.ok(Object.hasOwn(en, key.slice(0, -3)), key);
    assert.ok(Object.hasOwn(zh, key) || englishFragments.has(key) || key.endsWith('One') && (Object.hasOwn(zh, key.slice(0, -3)) || englishFragments.has(key.slice(0, -3))), key);
  }
  for (const key of Object.keys(zh)) assert.ok(Object.hasOwn(en, key), key);
});

test('settings draft reset clears target-specific controls and disables writes until new data loads', () => {
  const fixture = priceFixture(), defaults = node(fixture.document, 'div', 'settings-defaults'); fixture.root.append(defaults); defaults.append(node(fixture.document, 'button', 'old-target'));
  const idleReclaim = node(fixture.document, 'div', 'settings-idle-reclaim'); fixture.root.append(idleReclaim); idleReclaim.append(node(fixture.document, 'input', 'settings-hot-ttl-minutes'));
  appendPriceRow(fixture.base, 'old-target', fixture.rate, false, fixture); resetSettingsDrafts(fixture.root);
  assert.equal(defaults.children.length, 0); assert.equal(idleReclaim.children.length, 0); assert.equal(fixture.base.children.length, 0); assert.equal(fixture.root.querySelector('#settings-save').disabled, true); assert.equal(fixture.root.querySelector('#settings-add-model').disabled, true);
});

test('failed pricing summary is unknown while a successful empty response is zero', () => {
  const failed = priceFixture(); const bad = createPricingPanel({ ...failed, usage: null, write: async () => {}, t }); assert.match(failed.root.textContent, /wb.unknown/); assert.doesNotMatch(failed.root.textContent, /\$0.0000/); bad.destroy();
  const empty = priceFixture(); const good = createPricingPanel({ ...empty, usage: { models: [], unmatched: [] }, write: async () => {}, t }); assert.match(empty.root.textContent, /\$0.0000/); good.destroy();
});

test('literal settings translation keys used by modules exist in a language pack', () => {
  const packs=['en','zh'].map(lang=>({...JSON.parse(fs.readFileSync(new URL('../public/i18n/'+lang+'.json',import.meta.url))),...JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.'+lang+'.json',import.meta.url)))}));
  for(const file of ['settings','settings-defaults','settings-pricing','settings-ui','settings-version']){
    const source=fs.readFileSync(new URL('../public/js/wb/'+file+'.js',import.meta.url),'utf8');
    for(const match of source.matchAll(/\bt\('([^']+)'(?=\s*[,\)])/g))for(const pack of packs)assert.ok(Object.hasOwn(pack,match[1]),file+': '+match[1]);
  }
});

test('default controls retain the restart lock after an accepted runtime change', async () => {
  const document = documentFixture(), root = document.createElement('div');
  let writable = true;
  const meta = { current_model: 'one', current_effort: 'high', models: [{ id: 'one' }], efforts_by_model: { one: ['high'] } };
  const healthy = { ...snapshot(), instance: { runtimeHealth: { codex: { health: 'ok' }, claude: { health: 'ok' } } } };
  const panel = renderDefaults(root, { confirm: async () => true, snapshot: healthy, metadata: { claude: meta, codex: meta }, document, t,
    read: async () => ({}), writable: () => writable,
    execute: async () => { writable = false; return true; } });
  await selectEngine(root, 'codex');
  await root.querySelector('#settings-set-default').dispatch('click');
  assert.equal(root.querySelector('#settings-engine').disabled, false, 'read-only settings still allow browsing engines');
  for (const id of ['settings-set-default', 'settings-save-models', 'settings-model-claude', 'settings-effort-claude', 'settings-model-codex', 'settings-effort-codex'])
    assert.equal(root.querySelector('#' + id).disabled, true, id);
  panel.destroy();
});

test('the zylos version card shows the checked version, offers the upgrade instruction only for a newer release, and no Dashboard version', async () => {
  const document = documentFixture(), root = document.createElement('div'), offered = [];
  const tt = (key, values) => values ? key + JSON.stringify(values) : key;
  const show = update => renderCoreUpdate(root, update, { document, t: tt, formatTime: value => 'at ' + value, onUpgrade: prompt => offered.push(prompt) });
  show({ current: '1.0.0-beta.7', latest: '1.0.0', hasUpdate: true, checkedAt: 'T1' });
  assert.match(root.textContent, /zylos · v1\.0\.0-beta\.7/); assert.match(root.textContent, /checkedAt\{"time":"at T1"\}/);
  assert.doesNotMatch(root.textContent, /Dashboard/, 'Dashboard ships inside Core and has no version of its own');
  const button = root.querySelector('#settings-zylos-update'); assert.match(button.textContent, /"version":"v1\.0\.0"/);
  await button.dispatch('click');
  assert.deepEqual(offered, [coreUpgradePrompt('1.0.0-beta.7', '1.0.0', tt)]); assert.match(offered[0], /"from":"v1\.0\.0-beta\.7","to":"v1\.0\.0"/);
  show({ current: '1.0.0', latest: '1.0.0', hasUpdate: false, checkedAt: null });
  assert.equal(root.querySelector('button'), null); assert.match(root.textContent, /wb\.settings\.version\.notChecked/);
  for (const current of [undefined, null, '', ' ', 'unknown']) {
    show({ current, latest: '2', hasUpdate: true, checkedAt: 'T2' });
    assert.match(root.textContent, /zylos · wb\.unknown/, JSON.stringify(current)); assert.doesNotMatch(root.textContent, /zylos · v/, JSON.stringify(current));
  }
  await root.querySelector('#settings-zylos-update').dispatch('click'); assert.match(offered.at(-1), /"from":"wb\.unknown"/);
  show(undefined); assert.match(root.textContent, /zylos · status\.loading/); assert.equal(root.querySelector('button'), null);
  show(null); assert.match(root.textContent, /zylos · wb\.unknown.*wb\.readFailed/); assert.equal(root.querySelector('button'), null);
});

test('the header version follows the viewed instance and never falls back to an earlier one', () => {
  const document = documentFixture(), el = node(document, 'span'); el.hidden = true;
  renderBrandVersion(el, { zylos: { installed: '1.0.0-beta.7' } });
  assert.equal(el.textContent, 'v1.0.0-beta.7'); assert.equal(el.hidden, false);
  // Switching to another instance: its state is cleared first, then arrives without a readable version.
  for (const info of [undefined, { zylos: { installed: 'unknown' } }, { runtime: 'claude' }]) {
    renderBrandVersion(el, info);
    assert.equal(el.textContent, '', JSON.stringify(info)); assert.equal(el.hidden, true, JSON.stringify(info));
  }
  renderBrandVersion(el, { zylos: { installed: '0.9.6' } });
  assert.equal(el.textContent, 'v0.9.6', 'another instance shows its own version'); assert.equal(el.hidden, false);
  assert.doesNotThrow(() => renderBrandVersion(null, { zylos: { installed: '1' } }), 'a page without the header element is left alone');
});

test('the Core version is read only from the instance\'s own version record', () => {
  assert.equal(coreVersion({ zylos: { installed: '1.0.0-beta.7' } }), '1.0.0-beta.7');
  assert.equal(coreVersion({ zylos: { installed: ' 0.9.6\n' } }), '0.9.6');
  for (const info of [undefined, null, {}, { zylos: { installed: null } }, { zylos: { installed: '' } }, { zylos: { installed: 'unknown' } }, { zylos: { installed: 7 } }, { version: '1.0.0' }]) {
    assert.equal(coreVersion(info), null, JSON.stringify(info));
  }
});

test('remote machine rows show the poller connection state and remove through the callback', async () => {
  const document = documentFixture(), root = document.createElement('div'), removed = [];
  const agents = [{ name: 'ok', base_url: 'https://ok', access: 'admin' }, { name: 'auth', base_url: 'https://a' }, { name: 'down', base_url: 'https://d' }, { name: 'new', base_url: 'https://n' }];
  const records = [{ name: 'ok', link: { quality: 'ok', latency_ms: 120.4 } }, { name: 'auth', health_reason: 'auth_failed', pulse_rate: 0 }, { name: 'down', health_reason: 'unreachable', pulse_rate: 0 }];
  assert.deepEqual(remoteStatus(records[0]), { kind: 'ok', latency: 120 }); assert.equal(remoteStatus(undefined).kind, 'unknown'); assert.equal(remoteStatus({ health_reason: 'not_polled' }).kind, 'pending');
  renderRemoteAgents(root, agents, { records, document, t, onRemove: name => removed.push(name) });
  const rows = root.children; assert.equal(rows.length, 4);
  assert.match(rows[0].textContent, /wb\.settings\.fleet\.reachable · fleet_manage\.scope_admin · 120ms/);
  assert.match(rows[1].textContent, /wb\.settings\.fleet\.auth/); assert.match(rows[2].textContent, /wb\.settings\.fleet\.down/); assert.match(rows[3].textContent, /wb\.settings\.fleet\.unknown/);
  await rows[1].querySelector('.fleet-agent-remove').dispatch('click'); assert.deepEqual(removed, ['auth']);
  renderRemoteAgents(root, [], { document, t }); assert.equal(root.textContent, 'fleet_manage.empty');
});

test('revoking, rotating and deleting a key each ask first, and cancelling sends nothing', async () => {
  const document = documentFixture(), root = document.createElement('div'), asked = [], ran = [];
  let answer = false;
  const keys = [{ name: 'ops', scope: 'admin', status: 'active' }, { name: 'old', scope: 'read', status: 'revoked' }];
  renderKeyTable(root, keys, { document, t: (key, params) => params ? key + ':' + params.name : key,
    confirm: async (text, options) => { asked.push([options.title, text, options.ok, options.danger]); return answer; }, onAction: (action, name) => ran.push([action, name]) });
  const click = selector => root.querySelector(selector).dispatch('click');
  await click('.api-key-revoke');
  assert.deepEqual(asked.at(-1), ['wb.settings.keys.confirm.revoke.title:ops', 'wb.settings.keys.confirm.revoke.body:ops', 'wb.settings.keys.revoke', true]);
  assert.deepEqual(ran, [], 'cancel sends nothing');
  answer = true; await click('.api-key-revoke'); assert.deepEqual(ran, [['revoke', 'ops']]);
  answer = false; await click('.api-key-rotate');
  assert.deepEqual(asked.at(-1), ['wb.settings.keys.confirm.rotate.title:ops', 'wb.settings.keys.confirm.rotate.body:ops', 'wb.settings.keys.rotate', false], 'rotating is not a destructive red action');
  assert.equal(ran.length, 1);
  answer = false; await click('.api-key-delete');
  assert.deepEqual(asked.at(-1), ['wb.settings.keys.confirm.delete.title:old', 'wb.settings.keys.confirm.delete.body:old', 'wb.settings.keys.delete', true]);
  assert.equal(ran.length, 1);
  answer = true; await click('.api-key-delete'); assert.deepEqual(ran.at(-1), ['delete', 'old']);
  assert.equal(keyActionConfirmation('copy', 'ops'), null);
});

test('a key table wired without a confirmation runs nothing', async () => {
  const document = documentFixture(), root = document.createElement('div'), ran = [];
  renderKeyTable(root, [{ name: 'ops', scope: 'admin', status: 'active' }, { name: 'old', scope: 'read', status: 'revoked' }], { document, t, onAction: (action, name) => ran.push([action, name]) });
  for (const selector of ['.api-key-revoke', '.api-key-rotate', '.api-key-delete']) await root.querySelector(selector).dispatch('click');
  assert.deepEqual(ran, []);
});

test('key table keeps the server order and gives each key its own text actions', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const keys = [{ name: 'ops', scope: 'admin', status: 'active', created_at: '2026-02-03T04:05:06Z', last_used_at: null }, { name: 'old', scope: 'read', status: 'revoked', created_at: '2026-01-02T03:04:05Z' }];
  renderKeyTable(root, keys, { document, t, confirm: async () => true, onAction: (action, name) => calls.push([action, name]) });
  const rows = root.querySelector('tbody').children; assert.deepEqual(rows.map(row => row.children[0].textContent), ['ops', 'old']);
  assert.ok(rows[0].textContent.includes(formatZoned(keys[0].created_at)));
  assert.match(rows[0].textContent, /wb\.settings\.keys\.never/);
  assert.ok(rows[0].querySelector('.api-key-rotate')); assert.ok(rows[0].querySelector('.api-key-revoke')); assert.equal(rows[0].querySelector('.api-key-delete'), null);
  await rows[1].querySelector('.api-key-delete').dispatch('click'); assert.deepEqual(calls, [['delete', 'old']]);
});

test('price change counts cover edited cells, added rows and removed rows', () => {
  const rate = { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 1 };
  assert.equal(countPriceChanges({ a: rate, b: rate }, { a: rate, b: rate }), 0);
  assert.equal(countPriceChanges({ a: rate, b: rate }, { a: { ...rate, input: 3, output: 4 }, b: rate }), 2);
  assert.equal(countPriceChanges({ a: rate, b: rate }, { a: rate, c: rate }), 2, 'one added, one removed');
  const fixture = priceFixture(); appendPriceRow(fixture.base, 'x', rate, false, fixture); appendPriceRow(fixture.base, '', rate, false, fixture);
  const draft = draftPriceRows(fixture.base.children); assert.ok(draft.x); assert.equal(Object.keys(draft).length, 2, 'a blank prefix is a new row');
});

test('a successful price save clears the unsaved count, the save bar, the navigation badge and the dirty cells', async () => {
  const fixture = priceFixture(), counts = [], writes = [];
  const bar = node(fixture.document, 'div'); bar.className = 'settings-footer'; bar.hidden = true; fixture.root.append(bar);
  const panel = createPricingPanel({ ...fixture, groupCounts: { claude: 3, codex: 1 }, usage: { models: [] }, t, write: async body => writes.push(body), onDirty: count => counts.push(count) });
  const input = fixture.base.children[0].querySelectorAll('input')[1]; input.value = '9'; await input.dispatch('input');
  const fast = fixture.root.querySelector('#settings-fast-multiplier'); fast.value = '4'; await fast.dispatch('input');
  assert.equal(counts.at(-1), 2); assert.equal(bar.hidden, false);
  await panel.save();
  assert.equal(writes.length, 1); assert.equal(writes[0].runtimes.claude.fastModeMultiplier, 4);
  assert.equal(counts.at(-1), 0); assert.equal(bar.hidden, true);
  assert.equal(fixture.root.querySelector('#settings-status').textContent, 'wb.settings.pricesSaved');
  assert.equal(fixture.base.children[0].querySelectorAll('input')[1].value, '9', 'the saved value stays on screen');
  assert.equal(fixture.base.children[0].querySelectorAll('input').some(cell => cell.classList.contains('wb-dirty-in')), false);
  assert.equal(fast.value, '4'); assert.equal(fast.classList.contains('wb-dirty-in'), false);
  await fixture.root.querySelector('#settings-price-tab-codex').dispatch('click'); await fixture.root.querySelector('#settings-price-tab-claude').dispatch('click');
  assert.equal(counts.at(-1), 0, 'switching tabs after the save finds nothing unsaved');
  fixture.base.children[0].querySelectorAll('input')[1].value = '5'; await fixture.base.children[0].querySelectorAll('input')[1].dispatch('input');
  assert.equal(counts.at(-1), 1, 'later edits count against the saved values'); panel.destroy();
});

test('saving an edited Codex priority price clears the unsaved count and keeps the value', async () => {
  const fixture = priceFixture(), counts = [], writes = [];
  const panel = createPricingPanel({ ...fixture, groupCounts: { claude: 3, codex: 1 }, usage: { models: [] }, t, write: async body => writes.push(body), onDirty: count => counts.push(count) });
  await fixture.root.querySelector('#settings-price-tab-codex').dispatch('click');
  const priority = () => fixture.priority.children[0].querySelectorAll('input')[1];
  priority().value = '7'; await priority().dispatch('input');
  assert.equal(counts.at(-1), 1);
  await panel.save();
  assert.equal(writes[0].runtimes.codex.priorityModelPrices.gpt.input, 7);
  assert.equal(counts.at(-1), 0, 'the priority table is part of the new baseline');
  assert.equal(priority().value, '7'); assert.equal(priority().classList.contains('wb-dirty-in'), false);
  await fixture.root.querySelector('#settings-price-tab-claude').dispatch('click'); await fixture.root.querySelector('#settings-price-tab-codex').dispatch('click');
  assert.equal(counts.at(-1), 0);
  panel.destroy();
});

test('a failed price save keeps the unsaved count', async () => {
  const fixture = priceFixture(), counts = [];
  const panel = createPricingPanel({ ...fixture, groupCounts: { claude: 3, codex: 1 }, usage: { models: [] }, t, write: async () => { throw new Error('write_failed'); }, onDirty: count => counts.push(count) });
  const input = fixture.base.children[0].querySelectorAll('input')[1]; input.value = '9'; await input.dispatch('input');
  await panel.save(); assert.equal(counts.at(-1), 1); assert.equal(fixture.root.querySelector('#settings-status').textContent, 'write_failed'); panel.destroy();
});

test('the pricing panel reports unsaved changes to its navigation badge and save bar', async () => {
  const fixture = priceFixture(), counts = [];
  const bar = node(fixture.document, 'div'); bar.className = 'settings-footer'; bar.hidden = true; fixture.root.append(bar);
  const panel = createPricingPanel({ ...fixture, groupCounts: { claude: 3, codex: 1 }, usage: { models: [] }, t, write: async () => {}, onDirty: count => counts.push(count) });
  assert.equal(counts.at(-1), 0); assert.equal(bar.hidden, true);
  const input = fixture.base.children[0].querySelectorAll('input')[1]; input.value = '9'; await input.dispatch('input');
  assert.equal(counts.at(-1), 1); assert.equal(bar.hidden, false);
  panel.addRow(); assert.equal(counts.at(-1), 2);
  panel.destroy(); assert.equal(counts.at(-1), 0); assert.equal(bar.hidden, true);
});

test('model thresholds switch with the selected model and save an explicit engine/model only', async () => {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const meta = { runtime: 'claude', current_model: 'opus', current_effort: 'high', models: [{ id: 'opus' }, { id: 'opus[1m]' }],
    efforts_by_model: { '*': ['high'] }, model_thresholds: { opus: 70, 'opus[1m]': 40 }, model_threshold_max: { opus: 95, 'opus[1m]': 40 } };
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude: meta }, document, t,
    confirm: async () => true, execute: async (action, body) => { calls.push({ action, body }); return true; } });
  const model = root.querySelector('#settings-model-claude'), threshold = root.querySelector('#settings-threshold-claude'), save = root.querySelector('#settings-save-models');
  assert.equal(threshold.value, '70'); assert.equal(threshold.max, '95'); assert.equal(threshold.min, '10');
  model.value = 'opus[1m]'; await model.dispatch('change');
  assert.equal(threshold.value, '40'); assert.equal(threshold.max, '40');
  threshold.value = '41'; await threshold.dispatch('input'); assert.equal(save.disabled, true);
  threshold.value = '9'; await threshold.dispatch('input'); assert.equal(save.disabled, true);
  threshold.value = '10'; await threshold.dispatch('input'); assert.equal(save.disabled, false);
  threshold.value = '35'; await threshold.dispatch('input'); assert.equal(save.disabled, false);
  await save.dispatch('click');
  assert.deepEqual(calls, [{ action: 'switch-model', body: { runtime: 'claude', model: 'opus[1m]', confirmed: true } },
    { action: 'set-threshold', body: { runtime: 'claude', model: 'opus[1m]', value: 35 } }]);
  assert.equal(save.hidden, true);
  model.value = 'opus'; await model.dispatch('change'); assert.equal(threshold.value, '70', 'the other model remains unchanged');
  panel.destroy();
});

test('custom model threshold waits for metadata and ignores a late response for an older selection', async () => {
  const document = documentFixture(), root = document.createElement('div'), pending = [];
  const meta = { runtime: 'codex', current_model: 'one', current_effort: 'high', models: [{ id: 'one' }], efforts_by_model: { one: ['high'] },
    model_thresholds: { one: 70 }, model_threshold_max: { one: 95 } };
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { codex: meta }, document, t,
    read: path => { const item = deferred(); pending.push({ path, ...item }); return item.promise; } });
  await selectEngine(root, 'codex');
  const model = root.querySelector('#settings-model-codex'), custom = root.querySelector('#settings-model-custom-codex'), threshold = root.querySelector('#settings-threshold-codex');
  model.value = '__custom__'; await model.dispatch('change'); custom.value = 'custom-large'; await custom.dispatch('input');
  assert.equal(threshold.disabled, true); assert.equal(threshold.value, ''); assert.equal(root.querySelector('#settings-save-models').disabled, true);
  const request = pending.at(-1); assert.match(request.path, /model=custom-large/);
  model.value = 'one'; await model.dispatch('change');
  request.resolve({ ...meta, model_thresholds: { ...meta.model_thresholds, 'custom-large': 40 }, model_threshold_max: { ...meta.model_threshold_max, 'custom-large': 40 } });
  await tick(); assert.equal(threshold.value, '70');
  custom.value = 'custom-large'; model.value = '__custom__'; await model.dispatch('change');
  pending.at(-1).resolve({ ...meta, model_thresholds: { ...meta.model_thresholds, 'custom-large': 40 }, model_threshold_max: { ...meta.model_threshold_max, 'custom-large': 40 } });
  await tick(); assert.equal(threshold.value, '40'); assert.equal(threshold.max, '40'); assert.equal(threshold.disabled, false);
  panel.destroy();
});

test('an unchanged migrated threshold outside new write limits does not block effort changes', async () => {
  for (const previous of [5, 100]) {
  const document = documentFixture(), root = document.createElement('div'), calls = [];
  const meta = { runtime: 'claude', current_model: 'opus', current_effort: 'high', models: [{ id: 'opus' }],
    efforts_by_model: { opus: ['high', 'low'] }, model_thresholds: { opus: previous }, model_threshold_max: { opus: 95 } };
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude: meta }, document, t,
    confirm: async () => true, execute: async (action, body) => { calls.push({ action, body }); return true; } });
  const effort = root.querySelector('#settings-effort-claude'), threshold = root.querySelector('#settings-threshold-claude'), save = root.querySelector('#settings-save-models');
  assert.equal(threshold.value, String(previous)); effort.value = 'low'; await effort.dispatch('change'); assert.equal(save.disabled, false);
  await save.dispatch('click'); assert.deepEqual(calls, [{ action: 'switch-effort', body: { runtime: 'claude', effort: 'low' } }]);
  threshold.value = '99'; await threshold.dispatch('input'); assert.equal(save.disabled, true, 'a new value must meet the write limit');
  panel.destroy();
  }
});

test('threshold-only save reports next-decision effect in both interface languages', async () => {
  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    const document = documentFixture(), root = document.createElement('div');
    const meta = { runtime: 'claude', current_model: 'opus', current_effort: 'high', models: [{ id: 'opus' }],
      efforts_by_model: { '*': ['high'] }, model_thresholds: { opus: 70 }, model_threshold_max: { opus: 95 } };
    const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude: meta }, document,
      t: key => messages[key] ?? key, confirm: async () => true, execute: async () => true });
    const threshold = root.querySelector('#settings-threshold-claude');
    threshold.value = '60'; await threshold.dispatch('input');
    await root.querySelector('#settings-save-models').dispatch('click');
    assert.equal(root.querySelector('#settings-model-result').textContent, locale === 'en'
      ? 'Saved. Thresholds apply at the next rotation decision.'
      : '已保存。 阈值在下一轮换会话判断生效。');
    panel.destroy();
  }
});

test('a custom model requests its own threshold instead of showing the current model fallback', async () => {
  const document = documentFixture(), root = document.createElement('div'), requests = [], response = deferred();
  const meta = { runtime: 'codex', current_model: 'small', current_effort: 'high', models: [{ id: 'small' }],
    efforts_by_model: { '*': ['high'] }, new_session_threshold: 62,
    model_thresholds: { small: 62 }, model_threshold_max: { small: 95 } };
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { codex: meta }, document, t,
    read: path => { requests.push(path); return response.promise; } });
  await selectEngine(root, 'codex');
  const model = root.querySelector('#settings-model-codex'), custom = root.querySelector('#settings-model-custom-codex');
  const threshold = root.querySelector('#settings-threshold-codex');
  assert.equal(threshold.value, '62');
  model.value = '__custom__'; await model.dispatch('change');
  custom.value = 'large-custom'; await custom.dispatch('input');
  assert.equal(requests.length, 1);
  const requested = new URL(requests[0], 'http://fixture.invalid');
  assert.equal(requested.pathname, '/api/instance/runtime-options');
  assert.equal(requested.searchParams.get('runtime'), 'codex');
  assert.equal(requested.searchParams.get('model'), 'large-custom');
  assert.equal(threshold.value, '', 'a different model must not inherit the current model threshold');
  assert.equal(threshold.disabled, true);
  response.resolve({ ...meta, model_thresholds: { ...meta.model_thresholds, 'large-custom': 40 },
    model_threshold_max: { ...meta.model_threshold_max, 'large-custom': 40 } });
  await tick();
  assert.equal(threshold.value, '40'); assert.equal(threshold.max, '40'); assert.equal(threshold.disabled, false);
  panel.destroy();
});


test('settings group status labels include sample age and last-known status tooltip', async () => {
  const document = documentFixture(), root = node(document, 'div');
  const data = snapshot(), sampledAt = Date.now() - 20000;
  data.rows[0] = { ...data.rows[0], state: { kind: 'idle', stale: true, sampledAt } };
  const panel = renderDefaults(root, { snapshot: data, document, t });
  await selectEngine(root, 'agy');
  const details = root.querySelector('details'); details.open = true;
  await details.dispatch('toggle');
  assert.ok(root.querySelector('.wb-status-age'));
  data.rows[0].state = { kind: 'unknown', reason: 'stale', sampledAt, lastState: 'idle' };
  panel.destroy();
  const next = renderDefaults(root, { snapshot: data, document, t });
  await selectEngine(root, 'agy');
  const updated = root.querySelector('details'); updated.open = true;
  await updated.dispatch('toggle');
  const labels = root.querySelectorAll('small');
  assert.ok(labels.some(label => label.title?.startsWith('wb.state.lastStatus:')));
  assert.equal(root.querySelector('.wb-status-age'), null);
  next.destroy();
});

test('pricing tabs render English for one and two running groups', () => {
  const labels = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
  const en = (key, values = {}) => (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  for (const count of [1, 2]) {
    const fixture = priceFixture();
    const panel = createPricingPanel({ ...fixture, groupCounts: { claude: count }, usage: { models: [] }, t: en, write: async () => {} });
    assert.ok(fixture.root.textContent.includes(count === 1 ? '1 running group uses these prices' : '2 running groups use these prices'));
    panel.destroy();
  }
});


test('key table formats UTC key clocks in the instance timezone', () => {
  const document = documentFixture(), root = document.createElement('div');
  setInstanceZone('Asia/Singapore');
  try {
    const at = '2026-02-03T04:05:06Z';
    renderKeyTable(root, [{ name: 'ops', scope: 'admin', created_at: at, last_used_at: at }], { document, t });
    const row = root.querySelector('tbody').children[0];
    assert.equal(row.children[3].textContent, formatZoned(at));
    assert.equal(row.children[4].textContent, formatZoned(at));
    assert.doesNotMatch(row.textContent, /2026-02-03T04:05/);
  } finally { setInstanceZone(null); }
});

test('default model without effort options hides the whole field and restores it on model change', async () => {
  const document = documentFixture(), root = node(document, 'div');
  const meta = { runtime: 'claude', current_model: 'haiku', current_effort: 'high',
    models: [{ id: 'haiku' }, { id: 'opus' }], efforts_by_model: { haiku: [], opus: ['high'] } };
  const panel = renderDefaults(root, { snapshot: snapshot(), metadata: { claude: meta }, document, t });
  const effort = root.querySelector('#settings-effort-claude'), field = effort.closest('label');
  assert.equal(field.hidden, true);
  assert.equal(field.children[0].textContent, 'actions.effort');
  assert.equal(field.children[1].className, 'wb-select-wrap');
  assert.equal(field.children[1].children.length, 2, 'select and decorative arrow share the hidden field');
  const model = root.querySelector('#settings-model-claude');
  model.value = 'opus'; await model.dispatch('change'); assert.equal(field.hidden, false);
  assert.equal(effort.children.length, 1);
  model.value = 'haiku'; await model.dispatch('change'); assert.equal(field.hidden, true);
  panel.destroy();
});

test('Antigravity version panel and upgrade button never inherit Claude names', () => {
  const document = documentFixture(), root = node(document, 'div'), upgrade = node(document, 'button');
  const label = node(document, 'span', 'action-cli-label'); upgrade.append(label);
  renderEngineVersion(root, { agy: { installed: '1.5.11' }, claude: { installed: 'wrong' } }, { document, upgrade, t, runtime: 'agy' });
  assert.match(root.textContent, /Antigravity · v1.5.11/);
  assert.doesNotMatch(root.textContent, /CC|Claude|wrong/);
  assert.equal(label.textContent, t('actions.upgrade_runtime', { runtime: 'Antigravity' }));
});
