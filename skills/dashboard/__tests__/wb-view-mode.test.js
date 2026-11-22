import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewMode, term, toolLabel, resolveTheme, observeTheme, groupObservable, wbWritable, tabForPath, instanceStatusText } from '../public/js/wb/view-mode.js';
import { createDocument, storage } from './fixtures/workbench-dom.js';

test('view level tolerates inaccessible storage and redraws without data requests', context => {
  const document = createDocument(); let draws = 0, requests = 0;
  context.mock.method(globalThis, 'fetch', () => { requests++; throw Error('unexpected request'); });
  const mode = createViewMode({ document, storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } } });
  assert.equal(mode.detailLevel(), 'plain'); const stop = mode.subscribe(() => draws++);
  mode.setDetailLevel('technical'); assert.equal(document.documentElement.dataset.detail, 'technical'); assert.equal(draws, 1); assert.equal(requests, 0);
  stop(); mode.setDetailLevel('invalid'); assert.equal(mode.detailLevel(), 'plain'); assert.equal(draws, 1);
});
test('view level persists only recognized values', () => {
  const saved = storage({ 'zylos-dashboard-detail-level': 'technical' });
  const mode = createViewMode({ document: createDocument(), storage: saved });
  assert.equal(mode.detailLevel(), 'technical'); mode.setDetailLevel('plain'); assert.equal(saved.getItem('zylos-dashboard-detail-level'), 'plain');
});
test('plain language helpers follow the view level', () => {
  // Origin has the same name in both views; the plain view reads it from wb.term.origin.
  assert.equal(term('origin', 'plain', key => ({ 'wb.term.origin': 'Origin' })[key]), 'Origin');
  assert.equal(term('origin'), 'origin'); assert.equal(term('origin', 'technical'), 'origin');
  assert.equal(toolLabel('Bash'), '运行命令'); assert.equal(toolLabel('Bash', 'technical'), 'Bash'); assert.equal(toolLabel('unknown'), '使用工具');
});
test('system theme reacts to media changes and removes its listener', () => {
  let handler, removed = false; const media = { matches: true, addEventListener(name, fn) { assert.equal(name, 'change'); handler = fn; }, removeEventListener(name, fn) { removed = name === 'change' && fn === handler; } };
  const values = []; const stop = observeTheme('system', value => values.push(value), () => media);
  assert.equal(values[0], 'dark'); media.matches = false; handler(); assert.equal(values[1], 'light'); stop(); assert.equal(removed, true);
  assert.equal(resolveTheme('wrong'), 'light'); assert.equal(resolveTheme('dark'), 'dark');
});
test('group details offer the observer when it is installed and enabled in Technical details mode', () => {
  const legacy = { installed: true, enabled: true };
  const modern = { state: 'installed', desired: { enabled: true } };
  for (const row of [{ sessionGroup: 'origin' }, { sessionGroup: null },
    { sessionGroup: 'telegram:sleeping', presence: 'not_running', live: null }]) {
    assert.equal(groupObservable(legacy, 'technical', row), true);
    assert.equal(groupObservable(modern, 'technical', row), true);
    assert.equal(groupObservable(modern, 'plain', row), false);
    assert.equal(groupObservable(null, 'technical', row), false);
    assert.equal(groupObservable({ state: 'not_installed' }, 'technical', row), false);
    assert.equal(groupObservable({ state: 'installed', desired: { enabled: false } }, 'technical', row), false);
  }
  assert.equal(groupObservable(modern, 'technical', null), false);
  assert.equal(wbWritable(() => true), false);
  assert.equal(wbWritable(() => false), true);
});

test('conversation navigation maps direct and fleet URLs without changing existing destinations', () => {
  for (const prefix of ['', '/dashboard', '/fleet/Remote', '/dashboard/fleet/Remote']) {
    assert.equal(tabForPath(prefix + '/chat'), 'chat');
    assert.equal(tabForPath(prefix + '/'), 'overview');
    assert.equal(tabForPath(prefix + '/schedule'), 'schedule');
    assert.equal(tabForPath(prefix + '/usage'), 'trends');
  }
});
test('instance status keeps raw values for technical detail', () => {
  const t = (key, values) => key + (values ? ' ' + JSON.stringify(values) : '');
  const data = { view: 'multi', session_mode: { sessionMode: 'multi' }, origin: { presence: 'not_running' } };
  assert.equal(instanceStatusText(data, t),
    'actions.instance_status {"view":"multi","mode":"multi","origin":"not_running"}');
  // Older instances report null and newer ones 'unreadable'; neither shows a raw value.
  for (const sessionMode of [null, 'unreadable']) {
    assert.equal(instanceStatusText({ session_mode: { sessionMode }, origin: { presence: 'running' } }, t),
      'actions.instance_status {"view":"value.unknown","mode":"value.unknown","origin":"running"}', String(sessionMode));
  }
});
