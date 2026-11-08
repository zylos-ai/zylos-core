import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
// The same module URL the page modules import, so the zone set here is the zone they read.
import { setInstanceZone, instanceZone, formatZoned, zonedDay, zonedInputValue, instantFromInput } from '../public/js/wb/instance-zone.js?v=100';
import { unnamedConversation } from '../public/js/wb/plain-text.js';
import { displayTime } from '../public/js/wb/event-labels.js';
import { eventTime } from '../public/js/wb/detail-overview.js';
import { formatStartedAt } from '../public/js/wb/detail.js';
import { waitText } from '../public/js/wb/view-mode.js';
import { activityStrip } from '../public/js/wb/activity-strip.js';
import { renderHost } from '../public/js/wb/host-panel.js';
import { renderAttention } from '../public/js/wb/attention-bar.js';

// Direct modules with an injected DOM; no browser, network or storage. The process zone stands in for the browser's
// and is set apart from the instance zone, so only the instance zone can give the expected text.
const BROWSERS = ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'];
const fmt = (at, options, timeZone, locale = 'en-US') => new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(at));
const FULL = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
// 17:30 UTC on 7 November 2026: 01:30 on 8 November in Shanghai.
const AT = Date.UTC(2026, 10, 7, 17, 30);

function zones(t, browser, instance) {
  const saved = process.env.TZ;
  t.after(() => { setInstanceZone(null); if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = browser;
  setInstanceZone(instance);
}

for (const browser of BROWSERS) {
  test(`dates and times are written in the instance zone whatever the browser zone (${browser})`, t => {
    zones(t, browser, 'Asia/Shanghai');
    assert.equal(instanceZone(), 'Asia/Shanghai');
    assert.equal(formatZoned(AT, 'en-US'), fmt(AT, FULL, 'Asia/Shanghai'));
    assert.equal(formatZoned(AT, 'en-US', { hour: '2-digit', minute: '2-digit' }), fmt(AT, { hour: '2-digit', minute: '2-digit' }, 'Asia/Shanghai'));
    assert.equal(zonedDay(AT), '2026-11-08');
    assert.equal(zonedInputValue(AT), '2026-11-08T01:30');
    assert.equal(instantFromInput('2026-11-08T01:30'), AT, 'a typed wall time is read in the instance zone');
    assert.equal(formatZoned(AT, 'en-US', { hour: '2-digit', minute: '2-digit' }, 'America/Los_Angeles'),
      fmt(AT, { hour: '2-digit', minute: '2-digit' }, 'America/Los_Angeles'), 'a page with its own report of the zone passes it');
    // Event and session times on the overview and group detail.
    assert.equal(displayTime(AT, 'plain', 'en-US'), fmt(AT, FULL, 'Asia/Shanghai'));
    assert.equal(formatStartedAt(AT / 1000, 'en-US'), fmt(AT, FULL, 'Asia/Shanghai'));
    const sameDay = eventTime(AT, 'plain', 'en-US', AT + 3600_000);
    assert.equal(sameDay.text, fmt(AT, { hour: '2-digit', minute: '2-digit' }, 'Asia/Shanghai'));
    // 15:00 UTC on 7 November is 23:00 on 7 November in Shanghai: another day than AT there, the same day in UTC.
    const earlier = Date.UTC(2026, 10, 7, 15, 0);
    assert.equal(eventTime(earlier, 'plain', 'en-US', AT).text,
      fmt(earlier, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }, 'Asia/Shanghai'), '7 November is another day in Shanghai');
    // Untitled conversations name their start time, with the date when it is another day in the instance zone.
    assert.equal(unnamedConversation({ createdAt: AT / 1000 }, key => key, { now: AT + 3600_000, locale: 'en-US' }),
      `chat.unnamed · ${fmt(AT, { hour: '2-digit', minute: '2-digit' }, 'Asia/Shanghai')}`);
    assert.equal(unnamedConversation({ createdAt: earlier / 1000 }, key => key, { now: AT, locale: 'en-US' }),
      `chat.unnamed · ${fmt(earlier, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }, 'Asia/Shanghai')}`);
    // Rate-limit recovery and activity strip titles.
    const until = AT + 600_000;
    assert.ok(waitText({ kind: 'rate_wait', cooldownUntil: until / 1000 }, 'technical', null, AT)
      .endsWith(fmt(until, { hour: 'numeric', minute: '2-digit', second: '2-digit' }, 'Asia/Shanghai')));
    const document = createDocument();
    const strip = activityStrip(document, { start: AT, cellSeconds: 60, cells: ['working'] });
    const bar = allNodes(strip).find(node => node.className?.includes('wb-bucket'));
    assert.ok(bar.title.startsWith(fmt(AT, { hour: 'numeric', minute: '2-digit', second: '2-digit' }, 'Asia/Shanghai')), bar.title);
  });
}

test('host chart labels and its data table use the instance zone', t => {
  zones(t, 'America/Los_Angeles', 'Asia/Shanghai');
  const document = createDocument(), root = document.createElement('main'), configs = [];
  const iso = new Date(AT).toISOString();
  renderHost(root, { current: {}, pm2: { online: 1, total: 1 }, cpuPeak: { value: 40, at: iso },
    series: [{ at: iso, cpu: { avg: 10, max: 40 }, mem: null, disk: null }] }, { document, level: 'technical', range: '24h',
    chartFactory: (_, config) => { configs.push(config); return { destroy() {} }; } });
  assert.deepEqual(configs[0].data.labels, [formatZoned(AT, undefined, { hour: '2-digit', minute: '2-digit' })]);
  assert.equal(configs[0].data.labels[0], fmt(AT, { hour: '2-digit', minute: '2-digit' }, 'Asia/Shanghai', undefined));
  assert.ok(root.textContent.includes(formatZoned(AT)), 'the data table writes the full time in the instance zone');
});

test('the attention bar names the rate-limit recovery time in the instance zone', t => {
  zones(t, 'America/Los_Angeles', 'Asia/Shanghai');
  const document = createDocument(), root = document.createElement('div'), until = AT + 600_000;
  renderAttention(root, { attention: { problems: [{ kind: 'rate_limited', runtime: 'claude', until: until / 1000 }] }, rows: [] },
    { document, now: AT, t: (key, values) => `${key} ${values?.time ?? ''}` });
  assert.ok(root.textContent.includes(fmt(until, { hour: '2-digit', minute: '2-digit' }, 'Asia/Shanghai', undefined)), root.textContent);
});

test('without a usable instance zone times read in UTC, not the browser zone', t => {
  for (const zone of [null, '', 'Not/AZone', undefined]) {
    zones(t, 'Asia/Shanghai', zone);
    assert.equal(instanceZone(), 'UTC');
    assert.equal(formatZoned(AT, 'en-US'), fmt(AT, FULL, 'UTC'));
    assert.equal(zonedDay(AT), '2026-11-07');
    assert.equal(instantFromInput('2026-11-07T17:30'), AT);
    assert.equal(formatZoned(AT, 'en-US', { hour: '2-digit', minute: '2-digit' }, null), fmt(AT, { hour: '2-digit', minute: '2-digit' }, 'UTC'),
      'a page whose report has no zone reads UTC too');
  }
});

test('typed wall times convert in the instance zone across daylight saving changes, and invalid input gives NaN', t => {
  zones(t, 'Asia/Shanghai', 'America/Los_Angeles');
  assert.equal(instantFromInput('2026-07-01T12:00'), Date.UTC(2026, 6, 1, 19, 0), 'summer time, UTC-7');
  assert.equal(instantFromInput('2026-12-01T12:00'), Date.UTC(2026, 11, 1, 20, 0), 'winter time, UTC-8');
  for (const at of [Date.UTC(2026, 6, 1, 19, 0), Date.UTC(2026, 11, 1, 20, 0)]) assert.equal(instantFromInput(zonedInputValue(at)), at);
  for (const bad of ['', '2026-02-30T10:00', '2026-11-08 10:00', '2026-11-08T25:00', null]) assert.ok(Number.isNaN(instantFromInput(bad)), String(bad));
  assert.equal(zonedInputValue('not a date'), '');
  assert.equal(formatZoned(NaN), '');
});
