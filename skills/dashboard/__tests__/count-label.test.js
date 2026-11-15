import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { counted, countLabel } from '../public/js/count-label.js';
import { ObserverHistory } from '../public/js/observer-history.js';

const readPack = name => JSON.parse(fs.readFileSync(new URL(`../public/i18n/${name}.json`, import.meta.url), 'utf8'));
const en = { ...readPack('en'), ...readPack('wb.en') };
const zh = { ...readPack('zh'), ...readPack('wb.zh') };
const translate = pack => (key, params = {}) => Object.entries(params).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, value ?? ''), pack[key] ?? key);
const t = translate(en);

// Pure rendering only: no server, database, browser, timers or subprocesses.
test('optional singular translations always have their base translation', () => {
  for (const name of ['en', 'zh', 'wb.en', 'wb.zh']) {
    const pack = readPack(name);
    for (const key of Object.keys(pack).filter(key => key.endsWith('One'))) {
      assert.equal(typeof pack[key.slice(0, -3)], 'string', `${name}: ${key}`);
    }
  }
});

test('the shared count renderer keeps the existing Fleet selection and Chinese fallback', () => {
  assert.equal(counted({ label: 'groups', labelOne: 'group' }, 'label', 1), 'group');
  assert.equal(counted({ label: 'groups', labelOne: 'group' }, 'label', 2), 'groups');
  for (const count of [0, 1, 2]) {
    assert.equal(countLabel(translate(zh), 'wb.board.groups', count), translate(zh)('wb.board.groups', { count }));
  }
});

test('diff overflow, revoked-key result and observer availability render one and two', () => {
  for (const [key, one, two] of [
    ['memory.diff_truncated', '+1 more line not shown', '+2 more lines not shown'],
    ['fleet_manage.purge_revoked_status', 'Purged 1 revoked key', 'Purged 2 revoked keys'],
    ['wb.observer.enabledRunning', 'Enabled · 1 running group available to observe', 'Enabled · 2 running groups available to observe'],
  ]) {
    assert.equal(countLabel(t, key, 1), one);
    assert.equal(countLabel(t, key, 2), two);
  }
});

test('history entries render a singular or plural redaction badge', () => {
  const createElement = () => ({ children: [], append(...children) { this.children.push(...children); }, querySelector() { return this.fields ??= createElement(); } });
  const history = Object.create(ObserverHistory.prototype);
  Object.assign(history, { t, doc: { createElement }, fields: new Map() });
  for (const count of [1, 2]) {
    const node = history.renderEntry({ id: 'entry', kind: 'text', redaction: { count, kinds: ['token'] } });
    assert.equal(node.querySelector('.history-fields').children[0].textContent, `${count} ${count === 1 ? 'redaction' : 'redactions'} · token`);
  }
});
