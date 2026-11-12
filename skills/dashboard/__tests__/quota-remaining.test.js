import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { accountUsedPercent, accountRuntimes, remainingQuotaPercent, quotaColor, quotaFillColor, instanceStrip } from '../public/js/wb/instance-strip.js';
import { fleetSelfFromSnapshot, renderAgentFleetHtml } from '../public/js/agent-fleet.js';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
import { setInstanceZone } from '../public/js/wb/instance-zone.js?v=100';

const fleet = { agents: [{ name: 'local', self: true, state: 'IDLE' }] };
const pack = locale => JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
const translator = values => (key, params = {}) => values[key]?.replace(/\{(\w+)\}/g, (_, name) => params[name]) ?? key;
function strip(snapshot, locale = 'en', options = {}) {
  const document = createDocument(), root = document.createElement('div');
  instanceStrip(root, snapshot, { document, t: translator(pack(locale)), ...options });
  return root;
}
const accounts = root => root.children.filter(node => node.classList.contains('wb-account'));

test('weekly remaining quota clamps used percentages and preserves unknown samples', () => {
  for (const [used, remaining] of [[0,100],[50,50],[90,10],[100,0],[125,0],[-5,100],[1,99],[0.5,99.5],['42',58], [null,null],[undefined,null],['',null],['invalid',null],[NaN,null],[Infinity,null]]) {
    assert.equal(remainingQuotaPercent(used), remaining, String(used));
  }
  for (const key of ['used_percentage', 'utilization', 'usedPercentage']) {
    assert.equal(remainingQuotaPercent(accountUsedPercent({ [key]: 90 })), 10);
  }
});

test('remaining quota maps continuously from green through yellow to red', () => {
  for (const [remaining, hue] of [[100,120],[50,60],[10,12],[0,0],[49,58.8]]) {
    assert.equal(quotaColor(remaining), `hsl(${hue} 75% var(--wb-quota-lightness))`);
    assert.equal(quotaFillColor(remaining), `hsl(${hue} var(--wb-quota-fill-saturation) var(--wb-quota-fill-lightness))`);
  }
});

test('strip and fleet include quota-only Codex and retain in-use engines without data', () => {
  const snapshot = { baselineRuntime: 'claude', rows: [], instance: { accounts: { codex: { usedPercentage: 90 } } } };
  assert.deepEqual(accountRuntimes(snapshot), ['claude', 'codex']);
  const boxes = accounts(strip(snapshot));
  assert.equal(boxes.length, 2);
  assert.match(boxes[0].textContent, /Claude.*No data/);
  assert.match(boxes[1].textContent, /Codex.*10%/);
  const self = fleetSelfFromSnapshot(snapshot);
  const html = renderAgentFleetHtml(fleet, { self });
  assert.match(html, /Claude<\/span>.*?<b>No data<\/b>/);
  assert.match(html, /Codex<\/span>.*?width:10%/);
  const absent = { baselineRuntime: 'claude', instance: { accounts: { claude: { utilization: 0 }, codex: null } } };
  assert.deepEqual(accountRuntimes(absent), ['claude']);
  assert.equal(accounts(strip(absent)).length, 1);
  assert.doesNotMatch(renderAgentFleetHtml(fleet, { self: fleetSelfFromSnapshot(absent) }), />Codex</);
  assert.deepEqual(accountRuntimes({ rows: [{ target: { runtime: 'codex' } }] }), ['codex']);
});

test('strip meters and percentage text use the same remaining hue and localized tooltips', () => {
  for (const locale of ['en', 'zh']) for (const level of ['plain', 'technical']) {
    const values = pack(locale), t = translator(values);
    for (const used of [0, 50, 90, 100, 125]) {
      const remaining = remainingQuotaPercent(used);
      const box = accounts(strip({ baselineRuntime: 'codex', instance: { accounts: { codex: { usedPercentage: used } } } }, locale, { level }))[0];
      const fill = allNodes(box).find(node => node.tagName === 'I' && node.style.width);
      assert.equal(fill.style.width, remaining + '%');
      assert.equal(fill.style.backgroundColor, quotaFillColor(remaining));
      const amount = box.children.at(-1);
      assert.equal(amount.textContent, remaining + '%');
      assert.equal(amount.style.color, quotaColor(remaining));
      assert.equal(box.title, t('wb.quotaRemaining', { pct: remaining }));
    }
    const labels = Object.fromEntries(['rate7d','quotaRemaining','quotaUnknown'].map(key => [key, values['wb.fleet.' + key]]));
    const html = renderAgentFleetHtml({ agents: [{ name: 'remote', state: 'IDLE', rate_limit_7d_pct: 90 }] }, { labels });
    assert.ok(html.includes(t('wb.quotaRemaining', { pct: 10 })));
    assert.match(html, /--wb-quota-color:hsl\(12 75% var\(--wb-quota-lightness\)\)/);
    assert.match(html, /width:10%/);
    assert.doesNotMatch(html, /wb-qbar-tk|wb-qbar hi|wb-qbar full/);
  }
});

test('strip authentication and cooldown states keep their existing text and omit quota meters', () => {
  for (const health of ['auth_failed', 'rate_limited', 'recovering']) {
    const root = strip({ baselineRuntime: 'codex', instance: { accounts: { codex: { usedPercentage: 90 } }, runtimeHealth: { codex: { health, cooldownUntil: null } } } });
    const box = accounts(root)[0];
    assert.equal(allNodes(box).some(node => node.classList.contains('wb-meter')), false);
    assert.doesNotMatch(box.textContent, /10%|7d left/);
    assert.ok(allNodes(box).some(node => node.classList.contains(health === 'auth_failed' ? 'wb-txt-err' : 'wb-txt-warn')));
  }
});


test('strip rounds fractional weekly quota in both percentage text and tooltip', () => {
  for (const locale of ['en', 'zh']) for (const level of ['plain', 'technical']) {
    const box = accounts(strip({ baselineRuntime: 'codex', instance: { accounts: { codex: { usedPercentage: 33.3 } } } }, locale, { level }))[0];
    assert.equal(box.children.at(-1).textContent, '67%');
    assert.equal(box.title, translator(pack(locale))('wb.quotaRemaining', { pct: 67 }));
  }
});

test('recorded quota shows its instance-local time in strip and fleet cards', () => {
  setInstanceZone('Asia/Shanghai');
  const now = Date.parse('2026-11-10T00:10:00+08:00');
  for (const locale of ['en', 'zh']) for (const sameDay of [true, false]) {
    const recordedAt = now - (sameDay ? 60000 : 3600000);
    const sample = { used_percentage: 7, recordedAt, live: false };
    const snapshot = { baselineRuntime: 'claude', instance: { accounts: { claude: sample } } };
    const values = pack(locale), t = translator(values);
    const box = accounts(strip(snapshot, locale, { now }))[0];
    assert.match(box.textContent, /93%/);
    assert.ok(box.textContent.includes(sameDay ? '00:09' : '23:10'));
    if (!sameDay) assert.match(box.textContent, /11\/09/);
    assert.doesNotMatch(box.textContent, /2026/);
    assert.ok(box.title.includes(t('wb.quotaRecordedHint')));
    assert.match(box.title, /没有会话上报额度|No session is currently reporting quota/);
    const labels = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('wb.fleet.')).map(([key, value]) => [key.slice(9), value]));
    const self = fleetSelfFromSnapshot(snapshot);
    const html = renderAgentFleetHtml({ agents: [{ name: 'local', self: true, state: 'IDLE' },
      { name: 'remote', state: 'IDLE', rate_limit_7d_pct: 7, rate_limit_7d_recorded_at: recordedAt, rate_limit_7d_live: false }] }, { self, labels });
    assert.equal((html.match(/class="wb-quota-recorded"/g) ?? []).length, 2, 'local and remote cards each show the recorded time');
    assert.ok(html.includes(t('wb.quotaRecordedHint')));
    assert.doesNotMatch(html, /2026/);
    sample.live = true;
    assert.doesNotMatch(accounts(strip(snapshot, locale, { now }))[0].textContent, /Recorded|记录/);
    sample.live = false; sample.used_percentage = null;
    assert.doesNotMatch(accounts(strip(snapshot, locale, { now }))[0].textContent, /Recorded|记录/);
  }
  setInstanceZone(null);
});
