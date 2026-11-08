import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedRunner, wireSettingsConfirmations } from '../public/js/wb/settings-wiring.js';
import { fleetPageOptions, renderFleetPage } from '../public/js/agent-fleet.js';
import { documentFixture, node } from './fixtures/settings-dom.js';

const t = (key, params = {}) => key + (Object.keys(params).length ? ':' + JSON.stringify(params) : '');

// A page with a body: every in-page dialog (.wb-modal) that opens is recorded and answered with `page.answer`.
function page({ answer = true } = {}) {
  const document = documentFixture(), dialogs = [];
  document.body = node(document, 'body');
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  const append = document.body.append.bind(document.body);
  const result = { document, dialogs, answer };
  document.body.append = (...nodes) => {
    append(...nodes);
    for (const added of nodes) {
      const dialog = added.querySelector('.wb-modal'); if (!dialog) continue;
      dialogs.push({ title: dialog.children[0].textContent, body: dialog.children[1].textContent });
      const [no, yes] = dialog.querySelector('.wb-modal-acts').children;
      queueMicrotask(() => (result.answer ? yes : no).dispatch('click'));
    }
  };
  return result;
}

// Records what each key action would send; nothing is sent unless the action is called.
function keyActions(sent) {
  return Object.fromEntries(['rotate', 'revoke', 'delete'].map(action => [action, name => { sent.push([action, name]); }]));
}

const meta = runtime => ({ runtime, current_model: 'one', current_effort: 'high', models: [{ id: 'one' }, { id: 'two' }], efforts_by_model: { one: ['high'], two: ['low', 'minimal'] } });
const defaultsValue = () => ({
  snapshot: { baselineRuntime: 'claude', instance: { runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'ok' } } }, overrides: { runtime: [], model: [] }, rows: [] },
  page: { runtimeTotal: 1 }, metadata: { claude: meta('claude'), codex: meta('codex') },
});

// The page's action runner as the app gives it: it performs the action and never asks.
const recordingRun = sent => async (action, body) => { sent.push({ action, body }); return true; };

function wired(p, options = {}) {
  return wireSettingsConfirmations({ document: p.document, t, keyActions: keyActions([]), run: recordingRun([]), writable: () => true, ...options });
}

test('revoking a key opens the in-page dialog, and cancelling it sends nothing', async () => {
  const p = page({ answer: false }), sent = [];
  const wiring = wired(p, { keyActions: keyActions(sent) });
  const root = node(p.document, 'div');
  wiring.renderKeyTable(root, [{ name: 'ops', scope: 'admin', status: 'active' }, { name: 'old', scope: 'read', status: 'revoked' }]);

  await root.querySelector('.api-key-revoke').dispatch('click');
  assert.equal(p.dialogs.length, 1, 'revoking shows one .wb-modal');
  assert.equal(p.dialogs[0].title, 'wb.settings.keys.confirm.revoke.title:{"name":"ops"}');
  assert.equal(p.document.body.querySelector('.wb-modal'), null, 'the dialog closes after the answer');
  assert.deepEqual(sent, [], 'cancel sends nothing');

  await root.querySelector('.api-key-delete').dispatch('click');
  assert.equal(p.dialogs.length, 2, 'deleting a revoked key asks too');
  assert.deepEqual(sent, [], 'cancel sends nothing');

  p.answer = true;
  await root.querySelector('.api-key-revoke').dispatch('click');
  await root.querySelector('.api-key-delete').dispatch('click');
  assert.equal(p.dialogs.length, 4);
  assert.deepEqual(sent, [['revoke', 'ops'], ['delete', 'old']], 'confirming runs exactly the asked action');
});

test('saving model and effort for both engines asks once, then runs every change without asking again', async () => {
  const p = page(), sent = [], busy = [];
  const wiring = wired(p, { run: recordingRun(sent), setBusy: value => busy.push(value) });
  const root = node(p.document, 'div');
  wiring.renderDefaults(root, defaultsValue(), async () => ({}));
  for (const runtime of ['claude', 'codex']) {
    const model = root.querySelector('#settings-model-' + runtime); model.value = 'two'; await model.dispatch('change');
    const effort = root.querySelector('#settings-effort-' + runtime); effort.value = runtime === 'codex' ? 'minimal' : 'low'; await effort.dispatch('change');
  }
  await root.querySelector('#settings-save-models').dispatch('click');
  assert.equal(p.dialogs.length, 1, 'one .wb-modal for the whole card, none per action');
  assert.match(p.dialogs[0].body, /^wb\.settings\.confirmModels/);
  assert.deepEqual(busy, [true, false], 'the page is locked only while asking');
  assert.deepEqual(sent.map(item => item.action).sort(), ['switch-effort', 'switch-effort', 'switch-model', 'switch-model']);
});

test('cancelling the model save sends nothing', async () => {
  const p = page({ answer: false }), sent = [];
  const wiring = wired(p, { run: recordingRun(sent) });
  const root = node(p.document, 'div');
  wiring.renderDefaults(root, defaultsValue(), async () => ({}));
  const model = root.querySelector('#settings-model-claude'); model.value = 'two'; await model.dispatch('change');
  await root.querySelector('#settings-save-models').dispatch('click');
  assert.equal(p.dialogs.length, 1);
  assert.deepEqual(sent, []);
});

test('switching the default engine asks once and names the remote machine it acts on', async () => {
  const p = page(), sent = [];
  const wiring = wired(p, { run: recordingRun(sent), remoteTarget: () => 'lab' });
  const root = node(p.document, 'div');
  wiring.renderDefaults(root, defaultsValue(), async () => ({}));
  await root.querySelector('#settings-use-codex').dispatch('click');
  await root.querySelector('#settings-save-runtime').dispatch('click');
  assert.equal(p.dialogs.length, 1, 'one .wb-modal');
  assert.match(p.dialogs[0].body, /confirm\.switch_runtime_codex/);
  assert.match(p.dialogs[0].body, /\nconfirm\.remote_target:\{"agent":"lab"\}$/);
  assert.deepEqual(sent, [{ action: 'switch-runtime', body: { runtime: 'codex' } }]);
});

test('the card\'s executor runs an action only when the card says it was confirmed', async () => {
  const sent = [], execute = confirmedRunner(recordingRun(sent));
  assert.equal(await execute('switch-model', { model: 'two' }), false);
  assert.equal(await execute('switch-model', { model: 'two' }, { confirmed: false }), false);
  assert.equal(await execute('switch-model', { model: 'two' }, { confirmed: 'yes' }), false);
  assert.deepEqual(sent, [], 'nothing runs unconfirmed');
  assert.equal(await execute('switch-model', { model: 'two' }, { confirmed: true }), true);
  assert.deepEqual(sent, [{ action: 'switch-model', body: { model: 'two' } }]);
});

test('the Machines page says how long ago a machine was reachable in the page language', () => {
  const now = Date.parse('2026-11-08T12:00:00Z'), ago = ms => new Date(now - ms).toISOString();
  const zh = (key, params = {}) => key === 'time.hours_exact' ? params.h + ' 小时前' : t(key, params);
  const options = fleetPageOptions({ t: zh, fmtAge: () => '10 分钟前', labels: { lastSeen: '{time}最后在线' }, now: () => now });
  assert.equal(options.ageText(ago(2 * 3600e3 + 60e3)), '2 小时前');
  assert.equal(options.ageText(ago(3600e3)), '1 小时前', 'whole hours from the first hour on');
  assert.equal(options.ageText(ago(2 * 3600e3 - 60e3)), '1 小时前', 'counts whole hours, never rounds up');
  assert.equal(options.ageText(ago(3600e3 - 1000)), '10 分钟前', 'under an hour keeps the page\'s own short wording');
  // The page renders through renderFleetPage, so the page language always reaches the cards.
  const container = { innerHTML: '' };
  renderFleetPage(container, { agents: [{ name: 'lab', state: 'OFFLINE', health_reason: 'unreachable', last_seen: ago(2 * 3600e3 + 60e3) }] },
    { t: zh, fmtAge: () => '10 分钟前', labels: { lastSeen: '{time}最后在线' }, basePath: '/dash', now: () => now });
  assert.match(container.innerHTML, /2 小时前最后在线/);
  assert.doesNotMatch(container.innerHTML, /2h/);
});
