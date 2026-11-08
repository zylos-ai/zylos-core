import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedRunner, keyActionRequest, wireSettingsConfirmations } from '../public/js/wb/settings-wiring.js';
import { createActionRunner } from '../public/js/wb/action-runner.js';
import { fleetPageOptions, renderFleetPage } from '../public/js/agent-fleet.js';
import { documentFixture, node } from './fixtures/settings-dom.js';

const t = (key, params = {}) => key + (Object.keys(params).length ? ':' + JSON.stringify(params) : '');

// A page with a body: every in-page dialog (.wb-modal) that opens is recorded and answered with `page.answer`
// (or, when it is a list, with its answers in order).
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
      queueMicrotask(() => ((Array.isArray(result.answer) ? result.answer.shift() : result.answer) ? yes : no).dispatch('click'));
    }
  };
  return result;
}

// The page side of key requests: records each request as method and path, answers `answer`, and records what it shows.
function keyRequests(sent, { answer = { ok: true, data: { keys: [] } }, created = null } = {}) {
  const shown = { keys: [], created: [], status: [], busy: [] };
  const keyPage = {
    request: async (method, path) => { sent.push([method, path]); return typeof answer === 'function' ? answer(method, path) : answer; },
    renderKeys: data => shown.keys.push(data), renderCreated: key => { shown.created.push(key); created = key; }, createdKey: () => created,
    status: (text, kind) => shown.status.push([text, kind]), busy: on => shown.busy.push(on), errorText: (code, fallback) => code ?? fallback,
  };
  return Object.assign(keyPage, { shown });
}

const meta = runtime => ({ runtime, current_model: 'one', current_effort: 'high', models: [{ id: 'one' }, { id: 'two' }], efforts_by_model: { one: ['high'], two: ['low', 'minimal'] } });
const defaultsValue = () => ({
  snapshot: { baselineRuntime: 'claude', instance: { runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'ok' } } }, overrides: { runtime: [], model: [] }, rows: [] },
  page: { runtimeTotal: 1 }, metadata: { claude: meta('claude'), codex: meta('codex') },
});

// The page's real action runner, recording what it sends and every time it asks.
function recordingRunner(sent, asked = []) {
  return createActionRunner({ t, readOnly: () => false, confirmText: action => action,
    confirm: async text => { asked.push(text); return true; }, send: async (action, body) => { sent.push({ action, body }); return true; } });
}

function wired(p, options = {}) {
  return wireSettingsConfirmations({ document: p.document, t, keyPage: keyRequests([]), runner: recordingRunner([]), writable: () => true, ...options });
}

test('revoking a key opens the in-page dialog, and cancelling it sends nothing', async () => {
  const p = page({ answer: false }), sent = [];
  const wiring = wired(p, { keyPage: keyRequests(sent) });
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
  assert.deepEqual(sent, [['DELETE', '/api/keys/ops'], ['DELETE', '/api/keys/old?permanent=1']],
    'confirming sends exactly the asked action: revoking keeps the key, only deleting removes it for good');
});

test('each key action sends its own request after the table confirms it', async () => {
  const p = page(), sent = [];
  const wiring = wired(p, { keyPage: keyRequests(sent) });
  const root = node(p.document, 'div');
  wiring.renderKeyTable(root, [{ name: 'ops/1', scope: 'admin', status: 'active' }, { name: 'old', scope: 'read', status: 'revoked' }]);
  await root.querySelector('.api-key-rotate').dispatch('click');
  await root.querySelector('.api-key-revoke').dispatch('click');
  await root.querySelector('.api-key-delete').dispatch('click');
  assert.equal(p.dialogs.length, 3);
  assert.deepEqual(sent, [
    ['POST', '/api/keys/ops%2F1/rotate'],
    ['DELETE', '/api/keys/ops%2F1'],
    ['DELETE', '/api/keys/old?permanent=1'],
  ]);
});

test('rotating a key shows the new key once, with the name the server gave it', async () => {
  const p = page(), sent = [];
  const keyPage = keyRequests(sent, { answer: { ok: true, data: { keys: [{ name: 'ops' }], key: { name: 'ops' }, plaintext_key: 'zdk_new' } } });
  const root = node(p.document, 'div');
  wired(p, { keyPage }).renderKeyTable(root, [{ name: 'ops', scope: 'admin', status: 'active' }]);
  await root.querySelector('.api-key-rotate').dispatch('click');
  assert.deepEqual(sent, [['POST', '/api/keys/ops/rotate']]);
  assert.deepEqual(keyPage.shown.created, [{ name: 'ops', plaintext_key: 'zdk_new' }], 'the new key is shown');
  assert.deepEqual(keyPage.shown.keys, [{ keys: [{ name: 'ops' }], key: { name: 'ops' }, plaintext_key: 'zdk_new' }], 'the list is redrawn from the answer');
  assert.deepEqual(keyPage.shown.status.at(-1), ['fleet_manage.key_rotated_status', 'success']);
  assert.deepEqual(keyPage.shown.busy, [true, false]);
});

test('rotating while another new key is still shown asks before replacing it; cancelling sends nothing', async () => {
  const p = page(), sent = [];
  const keyPage = keyRequests(sent, { created: { name: 'ci', plaintext_key: 'zdk_ci' } });
  const root = node(p.document, 'div');
  wired(p, { keyPage }).renderKeyTable(root, [{ name: 'ops', scope: 'admin', status: 'active' }]);
  p.answer = [true, false]; // the table's own question: yes; replacing the shown key: no
  await root.querySelector('.api-key-rotate').dispatch('click');
  assert.equal(p.dialogs.length, 2, 'the table asks, then the page asks before replacing the shown key');
  assert.match(p.dialogs[1].body, /fleet_manage\.replace_created_key_confirm:\{"name":"ci"\}/);
  assert.deepEqual(sent, [], 'nothing is sent');
  assert.deepEqual(keyPage.shown.created, [], 'the shown key stays');
});

test('revoking the key that is shown hides it; a refused request shows why and changes nothing', async () => {
  const p = page(), sent = [];
  const keyPage = keyRequests(sent, { created: { name: 'ops', plaintext_key: 'zdk_ops' } });
  const root = node(p.document, 'div');
  wired(p, { keyPage }).renderKeyTable(root, [{ name: 'ops', scope: 'admin', status: 'active' }]);
  await root.querySelector('.api-key-revoke').dispatch('click');
  assert.deepEqual(keyPage.shown.created, [null], 'the revoked key is no longer shown');
  const refused = keyRequests([], { answer: { ok: false, data: { error: 'must_revoke_first' } } });
  const other = node(p.document, 'div');
  wired(p, { keyPage: refused }).renderKeyTable(other, [{ name: 'ops', scope: 'admin', status: 'active' }]);
  await other.querySelector('.api-key-rotate').dispatch('click');
  assert.deepEqual(refused.shown.keys, []); assert.deepEqual(refused.shown.created, []);
  assert.deepEqual(refused.shown.status.at(-1), ['must_revoke_first', 'error']);
  assert.deepEqual(refused.shown.busy, [true, false]);
});

test('revoking a different key keeps the new key that is shown once', async () => {
  const p = page(), sent = [];
  const keyPage = keyRequests(sent, { created: { name: 'ci', plaintext_key: 'zdk_ci' } });
  const root = node(p.document, 'div');
  wired(p, { keyPage }).renderKeyTable(root, [{ name: 'ci', scope: 'read', status: 'active' }, { name: 'ops', scope: 'admin', status: 'active' }]);
  await root.querySelectorAll('.api-key-revoke')[1].dispatch('click');
  assert.deepEqual(sent, [['DELETE', '/api/keys/ops']], 'the other key is revoked');
  assert.deepEqual(keyPage.shown.created, [], 'the shown key is not hidden');
  assert.deepEqual(keyPage.createdKey(), { name: 'ci', plaintext_key: 'zdk_ci' });
});

test('key requests: revoking keeps the key, deleting removes it for good, rotating shows the new key once', () => {
  assert.deepEqual(keyActionRequest('revoke', 'a b'), { method: 'DELETE', path: '/api/keys/a%20b',
    status: { running: 'fleet_manage.revoking_key', failed: 'fleet_manage.revoke_failed', done: 'fleet_manage.key_revoked_status' } });
  assert.deepEqual(keyActionRequest('delete', 'a b'), { method: 'DELETE', path: '/api/keys/a%20b?permanent=1',
    status: { running: 'fleet_manage.deleting_key', failed: 'fleet_manage.delete_failed', done: 'fleet_manage.key_deleted_status' } });
  assert.deepEqual(keyActionRequest('rotate', 'a b'), { method: 'POST', path: '/api/keys/a%20b/rotate', showsNewKey: true,
    status: { running: 'fleet_manage.rotating_key', failed: 'fleet_manage.rotate_failed', done: 'fleet_manage.key_rotated_status' } });
  assert.equal(keyActionRequest('purge', 'a'), null, 'an unknown action sends nothing');
});

test('saving model and effort for both engines asks once, then runs every change without asking again', async () => {
  const p = page(), sent = [], busy = [], asked = [];
  const wiring = wired(p, { runner: recordingRunner(sent, asked), setBusy: value => busy.push(value) });
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
  assert.deepEqual(asked, [], 'the card hands its confirmed changes to the runner\'s no-ask path');
});

test('cancelling the model save sends nothing', async () => {
  const p = page({ answer: false }), sent = [];
  const wiring = wired(p, { runner: recordingRunner(sent) });
  const root = node(p.document, 'div');
  wiring.renderDefaults(root, defaultsValue(), async () => ({}));
  const model = root.querySelector('#settings-model-claude'); model.value = 'two'; await model.dispatch('change');
  await root.querySelector('#settings-save-models').dispatch('click');
  assert.equal(p.dialogs.length, 1);
  assert.deepEqual(sent, []);
});

test('switching the default engine asks once and names the remote machine it acts on', async () => {
  const p = page(), sent = [];
  const wiring = wired(p, { runner: recordingRunner(sent), remoteTarget: () => 'lab' });
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
  const sent = [], execute = confirmedRunner(async (action, body) => { sent.push({ action, body }); return true; });
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
