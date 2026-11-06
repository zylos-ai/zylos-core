import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewMode, technicalKeys, techOnly, term, toolLabel, resolveTheme, observeTheme, observerNavEntry, wbWritable, tabForPath } from '../public/js/wb/view-mode.js';
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
test('technical field list and plain language helpers follow the view level', () => {
  const keys = 'groupKey runId errorCode queue context modelColumn evidence toolRawCommand cronText taskId taskPriority syncProgress fileBudget commitHash tokens autoRotate toolCalls projects hostCurves remoteAddress versionLatency observerNav observerSettings'.split(' ');
  assert.equal(technicalKeys.size, keys.length); for (const key of keys) assert.equal(techOnly(key), true);
  assert.equal(techOnly('state'), false); assert.equal(techOnly('activity'), false);
  assert.equal(term('origin'), '系统助手'); assert.equal(term('origin', 'technical'), 'origin');
  assert.equal(toolLabel('Bash'), '运行命令'); assert.equal(toolLabel('Bash', 'technical'), 'Bash'); assert.equal(toolLabel('unknown'), '使用工具');
});
test('system theme reacts to media changes and removes its listener', () => {
  let handler, removed = false; const media = { matches: true, addEventListener(name, fn) { assert.equal(name, 'change'); handler = fn; }, removeEventListener(name, fn) { removed = name === 'change' && fn === handler; } };
  const values = []; const stop = observeTheme('system', value => values.push(value), () => media);
  assert.equal(values[0], 'dark'); media.matches = false; handler(); assert.equal(values[1], 'light'); stop(); assert.equal(removed, true);
  assert.equal(resolveTheme('wrong'), 'light'); assert.equal(resolveTheme('dark'), 'dark');
});
test('observer navigation follows detail, installation and enabled status', () => {
  assert.equal(observerNavEntry({ installed: true, enabled: true }, 'plain'), null);
  assert.equal(observerNavEntry(null, 'technical'), null);
  assert.equal(observerNavEntry(undefined, 'technical'), null);
  const primary = { 'tab.observer': 'Observer' };
  assert.equal(observerNavEntry({ installed: true, enabled: true }, 'technical', key => primary[key] ?? key).label, 'Observer');
  assert.equal(observerNavEntry({ installed: true, enabled: true }, 'technical').target, 'observer');
  assert.equal(observerNavEntry({ state: 'installed', desired: { enabled: true } }, 'technical').target, 'observer');
  assert.match(observerNavEntry({ installed: false }, 'technical').label, /去设置安装/);
  assert.equal(observerNavEntry({ installed: true, enabled: false }, 'technical').target, 'settings');
  assert.equal(wbWritable(() => true), false); assert.equal(wbWritable(() => false), true);
});

test('conversation navigation maps direct and fleet URLs without changing existing destinations', () => {
  for (const prefix of ['', '/dashboard', '/fleet/Remote', '/dashboard/fleet/Remote']) {
    assert.equal(tabForPath(prefix + '/chat'), 'chat');
    assert.equal(tabForPath(prefix + '/'), 'overview');
    assert.equal(tabForPath(prefix + '/schedule'), 'schedule');
    assert.equal(tabForPath(prefix + '/usage'), 'trends');
  }
});
