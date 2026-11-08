import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { actionConfirmText, bindActionControls, createPageActions, prepareAction } from '../public/js/wb/page-actions.js';
import { CONFIRM_ACTIONS } from '../public/js/wb/action-runner.js';
import { documentFixture, node } from './fixtures/settings-dom.js';

const t = (key, params = {}) => key + (Object.keys(params).length ? ':' + JSON.stringify(params) : '');

// The page's real actions with a recording sender and a confirmation that answers `answer` (a list answers in order).
function actions({ answer = true, readOnly = false, remote = null, shown = { sessionGroup: 'origin', runId: 'run-1', sessionId: 's-1' }, runtime = 'claude' } = {}) {
  const asked = [], sent = [], session = { current: shown };
  const run = createPageActions({
    t, readOnly: () => readOnly, remoteTarget: () => remote, shownSession: () => session.current, runtime: () => runtime,
    effortLabel: value => `effort:${value}`,
    confirm: async text => { asked.push(text); return Array.isArray(answer) ? answer.shift() : answer; },
    send: async (action, body) => { sent.push({ action, body }); return true; },
  });
  return { run, asked, sent, session };
}

// The session controls as the page builds them: the CLI upgrade button, the mode select with its segmented
// buttons, and the rotation threshold.
function controls() {
  const document = documentFixture();
  const upgrade = node(document, 'button'); upgrade.dataset.action = 'upgrade-cc';
  const mode = node(document, 'select', 'action-mode'); mode.value = 'multi'; mode._current = 'multi';
  const seg = ['multi', 'single'].map(value => { const button = node(document, 'button'); button.dataset.mode = value; return button; });
  const threshold = node(document, 'input', 'action-threshold'), apply = node(document, 'button', 'action-threshold-apply');
  const byId = { '[data-action="upgrade-cc"]': upgrade, '#action-mode': mode, '#action-threshold': threshold, '#action-threshold-apply': apply };
  const root = { querySelector: selector => byId[selector] ?? null, querySelectorAll: selector => (selector === '#action-mode-seg button' ? seg : []) };
  return { root, upgrade, mode, seg, threshold, apply };
}

test('upgrading the CLI from the session controls asks first; cancelling sends nothing', async () => {
  const no = actions({ answer: false }), c = controls();
  bindActionControls(c.root, no.run);
  await c.upgrade.dispatch('click');
  assert.deepEqual(no.asked, ['confirm.upgrade_cc']);
  assert.deepEqual(no.sent, []);
  const yes = actions({ runtime: 'codex' }), c2 = controls();
  bindActionControls(c2.root, yes.run);
  await c2.upgrade.dispatch('click');
  assert.deepEqual(yes.asked, ['confirm.upgrade_codex'], 'a Codex machine is asked about upgrading Codex');
  assert.deepEqual(yes.sent, [{ action: 'upgrade-cc', body: undefined }]);
});

test('switching the session mode asks first; a cancelled switch restores the mode and sends nothing', async () => {
  const no = actions({ answer: false }), c = controls(), settled = [];
  bindActionControls(c.root, no.run, { onModeSettled: () => settled.push(c.mode.value) });
  await c.seg[1].dispatch('click');
  assert.deepEqual(no.asked, ['confirm.switch_mode:{"mode":"single"}']);
  assert.deepEqual(no.sent, []);
  assert.deepEqual(settled, ['multi'], 'the select is back on the running mode when the page redraws');

  const yes = actions(), c2 = controls();
  bindActionControls(c2.root, yes.run);
  await c2.seg[1].dispatch('click');
  assert.equal(yes.asked.length, 1);
  assert.deepEqual(yes.sent, [{ action: 'switch-mode', body: { mode: 'single' } }]);
  c2.mode.value = 'multi';
  await c2.mode.dispatch('change');
  assert.equal(yes.asked.length, 2, 'the select itself asks the same way');
  assert.deepEqual(yes.sent.at(-1), { action: 'switch-mode', body: { mode: 'multi' } });
});

test('the segmented mode buttons do nothing for the current mode or while disabled', async () => {
  const a = actions(), c = controls();
  bindActionControls(c.root, a.run);
  await c.seg[0].dispatch('click');
  c.seg[1].disabled = true;
  await c.seg[1].dispatch('click');
  assert.deepEqual(a.asked, []); assert.deepEqual(a.sent, []);
});

test('the rotation threshold applies without asking, only for 10–95, from the button or Enter', async () => {
  const a = actions({ answer: false }), c = controls(), applied = [];
  bindActionControls(c.root, a.run, { onThreshold: value => applied.push(value) });
  c.threshold.value = '70';
  await c.apply.dispatch('click');
  c.threshold.value = '80';
  await c.threshold.dispatch('keydown', { key: 'Enter' });
  await c.threshold.dispatch('keydown', { key: 'a' });
  for (const value of ['5', '9', '10', '95', '96']) {
    c.threshold.value = value;
    await c.apply.dispatch('click');
  }
  assert.deepEqual(a.asked, [], 'the threshold does not change the running agent, so nothing is asked');
  assert.deepEqual(a.sent.map(item => item.body.value), [70, 80, 10, 95], 'both ends of 10–95 apply; 9 and 96 do not');
  assert.ok(a.sent.every(item => item.action === 'set-threshold'));
  assert.deepEqual(applied, [70, 80, 10, 95]);
});

test('a manual restart asks first and names the session shown at that moment, so Core can refuse a changed target', async () => {
  const a = actions();
  await a.run.exec('restart-session');
  a.session.current = { sessionGroup: 'origin', runId: 'run-2', sessionId: 's-2' };
  await a.run.exec('restart-session', { reason: 'stuck' });
  assert.deepEqual(a.asked, ['confirm.restart', 'confirm.restart']);
  assert.deepEqual(a.sent, [
    { action: 'restart-session', body: { sessionGroup: 'origin', runId: 'run-1', sessionId: 's-1' } },
    { action: 'restart-session', body: { reason: 'stuck', sessionGroup: 'origin', runId: 'run-2', sessionId: 's-2' } },
  ]);
  assert.deepEqual(prepareAction('switch-model', { model: 'two' }, { runId: 'run-1' }), { model: 'two' }, 'other actions are sent as they are');
});

test('every action that changes the running agent is asked with its own question, naming a remote machine', async () => {
  for (const action of CONFIRM_ACTIONS) {
    const a = actions({ answer: false, remote: 'lab' });
    await a.run.exec(action, { mode: 'single', runtime: 'codex', model: 'two', effort: 'high' });
    assert.equal(a.asked.length, 1, action);
    assert.match(a.asked[0], /\nconfirm\.remote_target:\{"agent":"lab"\}$/, action);
    assert.doesNotMatch(a.asked[0], /confirm\.fallback/, action + ' has its own question');
    assert.deepEqual(a.sent, [], action);
  }
  assert.equal(actionConfirmText('switch-effort', { effort: 'high' }, { t, effortLabel: value => `effort:${value}` }), 'confirm.switch_effort:{"value":"effort:high"}');
  assert.equal(actionConfirmText('switch-runtime', { runtime: 'codex' }, { t }), 'confirm.switch_runtime_codex');
});

test('nothing is asked or sent while the viewed machine was reached with a read-only key', async () => {
  const a = actions({ readOnly: true }), c = controls();
  bindActionControls(c.root, a.run);
  await c.upgrade.dispatch('click');
  await c.seg[1].dispatch('click');
  assert.equal(await a.run.exec('restart-session'), false);
  assert.deepEqual(a.asked, []); assert.deepEqual(a.sent, []);
});

// Text checks of the page script, which cannot be loaded outside a browser: quick guards that it hands the
// sender only to the modules above. Clicking through the real page (asked first, cancel sends nothing, confirm
// sends once) is the opt-in browser case in workbench-browser.test.js.
test('page script text: dashboard actions are sent only through the page actions', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.deepEqual(app.match(/\bsendAction\b/g), ['sendAction', 'sendAction'], 'the sender is defined once and handed only to the page actions');
  assert.match(app, /createPageActions\(\{\s*t, send: sendAction,/);
  assert.match(app, /shownSession: \(\) => state\.dashboardState,/, 'a manual restart names the session the page shows');
  assert.match(app, /function execAction\(action, body\) \{\s*return pageActions\(\)\.exec\(action, body\);\s*\}/, 'every page action asks through exec');
  assert.doesNotMatch(app, /runConfirmed/, 'only the default-settings card, after confirming, uses the no-ask path');
  assert.doesNotMatch(app, /createActionRunner/, 'the page has one action runner');
  assert.match(app, /bindActionControls\(overlay, pageActions\(\), \{/);
  assert.match(app, /wireSettingsConfirmations\(\{\s*document, t, runner: pageActions\(\),/);
});

test('page script text: the observer page and read-only state use the same viewed-machine access', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.deepEqual(app.match(/observerPageUsable\([^)]*\)/g), ['observerPageUsable(status, viewedMachine()'], 'the observer page is given the viewed machine as it is');
  assert.match(app, /function remoteIsReadOnly\(\) \{\s*const viewed = viewedMachine\(\);\s*return viewed\.viewingRemote && viewed\.access !== 'admin';\s*\}/);
  assert.doesNotMatch(app, /access: '(?:admin|read)'/, 'no access level is written into the page');
});
