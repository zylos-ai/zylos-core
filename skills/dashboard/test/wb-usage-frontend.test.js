import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createDocument, allNodes, deferred, tick, Node } from './fixtures/workbench-dom.js';
import { cachePath, renderUsage, createUsagePage, usagePath, formatUsageCount, bucketLabels, compactCount } from '../public/js/wb/usage.js';
import { renderHost, createHostPanel } from '../public/js/wb/host-panel.js';
import { instanceStrip } from '../public/js/wb/instance-strip.js';
import { setInstanceZone } from '../public/js/wb/instance-zone.js?v=100';
import { markCurrentTab } from '../public/js/wb/view-mode.js';

// Direct modules with injected DOM, charts and reads; no browser, network, storage or processes.
const fixture = () => {
  const document = createDocument(), events = new Node('document', document);
  document.addEventListener = events.addEventListener.bind(events);
  document.removeEventListener = events.removeEventListener.bind(events);
  document.dispatch = events.dispatch.bind(events);
  const root = document.createElement('main'), configs = []; let destroyed = 0;
  return { document, root, configs, chartFactory: (_, config) => { configs.push(config); return { destroy() { destroyed++; } }; }, destroyed: () => destroyed };
};
const value = {
  tz:'Asia/Singapore', buckets:['2026-11-01T16:00:00.000Z','2026-11-02T16:00:00.000Z'], bucket:'day',
  totals:{cost:5,costByRuntime:{claude:2,codex:3},messages:{in:4,out:2},tokens:999,rotations:1,tools:8},
  costByRuntime:[{runtime:'claude',at:'2026-11-01T16:00:00.000Z',value:2},{runtime:'codex',at:'2026-11-02T16:00:00.000Z',value:3}],
  tokensByRuntime:[], messages:[{at:'2026-11-01T16:00:00.000Z',in:4,out:2}], rotations:[{at:'2026-11-02T16:00:00.000Z',value:1}], tools:[{name:'Read',count:8}], projects:{items:[{name:'example',outputTokens:91}]},
};
for (const locale of ['en', 'zh']) test(`usage page explains deleted message totals in ${locale}`, async () => {
  const translations = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
  const f = fixture();
  const page = createUsagePage({ ...f, read: async () => value, t: key => translations[key] ?? key });
  await page.open();
  const note = allNodes(f.root).find(node => node.classList.contains('wb-usage-deletion-note'));
  assert.ok(note);
  assert.equal(note.textContent, translations['wb.usage.deletedConversations']);
  assert.match(note.textContent, locale === 'zh' ? /不再计入消息数/ : /no longer count toward message totals/);
  page.destroy();
});
test('usage plain view shows costs and signed messages with runtime stacks and tables', () => {
  const f=fixture(); const view=renderUsage(f.root,value,f);
  assert.equal(f.configs.length,2); assert.equal(f.configs[0].options.scales.x.stacked,true);
  assert.deepEqual(f.configs[0].data.datasets.map(d=>d.data),[[2,0],[0,3]]);
  assert.deepEqual(f.configs[1].data.datasets[1].data,[-2,-0]);
  assert.equal(f.root.textContent.includes('wb.usage.tokens'),false);
  assert.equal(allNodes(f.root).filter(n=>n.tagName==='TABLE').length,2);
  // Series are named in each card header instead of a chart legend; sent counts read as positive numbers there.
  assert.ok(f.configs.every(c=>c.options.plugins.legend.display===false));
  assert.equal(allNodes(f.root).filter(n=>n.classList.contains('wb-usage-key')).length,4);
  assert.deepEqual(f.configs[1].options.scales.y.ticks.callback(-8),8);
  assert.ok(f.root.textContent.includes('Claude $2.00 · Codex $3.00'));
  view.destroy(); assert.equal(f.destroyed(),2);
});
test('technical usage adds tokens rotations tools and output token projects without quotas', () => {
  const f=fixture(); renderUsage(f.root,value,{...f,level:'technical'});
  // Tools and projects are ranked bar lists, so only cost, messages, tokens and rotations are charts.
  assert.equal(f.configs.length,4);
  const bars=allNodes(f.root).filter(n=>n.classList.contains('wb-usage-bar-row')).map(n=>n.textContent);
  assert.deepEqual(bars,['Read8','example91']);
  assert.equal(f.root.textContent.includes('quota'),false);
});
test('count charts use whole-number ticks, and a period without session changes says so instead of an empty chart', () => {
  const f=fixture(); renderUsage(f.root,value,{...f,level:'technical'});
  const byTitle = title => f.configs.find(config => config.options && config.data.datasets[0]?.label === title);
  assert.equal(byTitle('wb.usage.rotations').options.scales.y.ticks.precision, 0, 'session changes are counted');
  assert.equal(byTitle('wb.usage.received').options.scales.y.ticks.precision, 0, 'messages are counted');
  assert.equal(f.configs[0].options.scales.y.ticks.precision, undefined, 'amounts keep their decimals');
  const quiet=fixture(); renderUsage(quiet.root,{ ...value, rotations: [{ at: value.buckets[0], value: 0 }] },{...quiet,level:'technical'});
  assert.equal(quiet.configs.length,3,'no chart is drawn for all-zero session changes');
  assert.ok(quiet.root.textContent.includes('wb.usage.noRotations'));
  assert.equal(allNodes(quiet.root).filter(n=>n.classList.contains('wb-usage-empty')).length,1);
});
test('usage page ignores closed and changed target replies and releases charts', async () => {
  const f=fixture(), pending=deferred(); let target='one',reads=0;
  const page=createUsagePage({...f,identity:()=>target,read:()=>{reads++;return pending.promise;}});
  const opening=page.open(); page.close(); pending.resolve(value); await opening;
  assert.equal(f.configs.length,0); assert.equal(reads,1);
  const other=deferred(); const next=createUsagePage({...f,identity:()=>target,read:()=>other.promise});
  const waiting=next.open(); target='two'; other.resolve(value); await waiting; assert.equal(f.configs.length,0);
  next.destroy(); page.destroy(); assert.equal(f.root.children.length,0);
});
test('custom invalid dates do not request and range URL carries explicit bounds', async () => {
  const f=fixture();let reads=0; const page=createUsagePage({...f,read:async()=>{reads++;return value;}});
  await page.open();
  allNodes(f.root).find(n=>n.id==='wb-usage-apply').dispatch('click');await tick();assert.equal(reads,1);
  assert.ok(f.root.textContent.includes('wb.usage.invalidRange'));assert.match(usagePath({range:'custom',since:'a',until:'b'}),/since=a&until=b/);page.destroy();
});
test('custom usage dates are read as wall time in the instance time zone, not the browser zone', async t => {
  const saved = process.env.TZ;
  t.after(() => { setInstanceZone(null); if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = 'America/Los_Angeles';
  setInstanceZone('Asia/Shanghai');
  const f = fixture(); const paths = [];
  const page = createUsagePage({ ...f, read: async path => { paths.push(path); return value; } });
  await page.open();
  const nodes = allNodes(f.root);
  nodes.find(node => node.id === 'wb-usage-since').value = '2026-11-01T00:00';
  nodes.find(node => node.id === 'wb-usage-until').value = '2026-11-02T00:00';
  nodes.find(node => node.id === 'wb-usage-apply').dispatch('click'); await tick();
  const query = new URLSearchParams(paths.at(-1).split('?')[1]);
  assert.equal(query.get('since'), '2026-10-31T16:00:00.000Z', 'midnight on 1 November in Shanghai');
  assert.equal(query.get('until'), '2026-11-01T16:00:00.000Z');
  page.destroy();
});
test('custom usage rejects a range longer than the allowed year before reading', async () => {
  const f = fixture(); let reads = 0;
  const page = createUsagePage({ ...f, read: async () => { reads++; return value; } });
  await page.open();
  const nodes = allNodes(f.root);
  nodes.find(node => node.id === 'wb-usage-since').value = '2025-01-01T00:00';
  nodes.find(node => node.id === 'wb-usage-until').value = '2026-02-01T00:00';
  nodes.find(node => node.id === 'wb-usage-apply').dispatch('click'); await tick();
  assert.equal(reads, 1);
  assert.ok(f.root.textContent.includes('wb.usage.invalidRange'));
  page.destroy();
});
test('host plain current values and technical curves preserve null gaps and peak', () => {
  const f=fixture(),data={current:{cpu_pct:10,mem_used_pct:20,disk_used_pct:30},pm2:{online:2,total:3},cpuPeak:{value:40,at:'2026-11-01T00:00:00Z'},series:[{at:'2026-11-01T00:00:00Z',cpu:{avg:10,max:40},mem:null,disk:null},{at:'2026-11-01T01:00:00Z',cpu:null,mem:null,disk:null}]};
  renderHost(f.root,data,f);assert.equal(f.configs.length,0);assert.ok(f.root.textContent.includes('2 / 3'));assert.ok(f.root.textContent.includes('10.0%'));
  const view=renderHost(f.root,data,{...f,level:'technical'});assert.equal(f.configs.length,3);assert.deepEqual(f.configs[0].data.datasets[0].data,[10,null]);assert.equal(f.configs[0].data.datasets[0].spanGaps,false);assert.ok(f.root.textContent.includes('40.0%'));view.destroy();assert.equal(f.destroyed(),3);
});
test('host panel shows the board snapshot pool in both views and follows a new snapshot on redraw', async () => {
  const f = fixture(), data = { current: {}, pm2: { online: 1, total: 1 }, series: [] }; let level = 'plain';
  let view = { mode: 'multi', pool: { used: 2, capacity: 3, capacityRecord: { valid: true, fresh: true, source: 'auto', reason: 'floor' } } };
  const panel = createHostPanel({ ...f, read: async () => data, detail: () => level, pool: () => view });
  const section = () => allNodes(f.root).find(node => node.classList.contains('wb-host-pool'));
  await panel.open();
  assert.equal(section().hidden, false); assert.ok(section().textContent.includes('2 / 3'));
  assert.ok(section().textContent.includes('wb.inst.poolAuto')); assert.ok(section().textContent.includes('wb.inst.poolFloor'));
  level = 'technical'; panel.setViewDetail(); assert.equal(f.configs.length, 3);
  assert.equal(section().hidden, false); assert.ok(section().textContent.includes('wb.inst.poolFloor'));
  // The shell redraws the open panel on every board snapshot (setViewDetail); the section reads the pool then.
  view = { mode: 'multi', pool: { ...view.pool, used: 3 } }; panel.setViewDetail();
  assert.ok(section().textContent.includes('3 / 3'));
  view = { mode: 'single', pool: view.pool }; panel.setViewDetail();
  assert.equal(section().hidden, true); assert.equal(section().children.length, 0);
  panel.destroy();
});
test('host close callback Escape and late reads preserve lifecycle', async () => {
  const f=fixture(),pending=deferred();let opened=0;const panel=createHostPanel({...f,onOpen:()=>opened++,read:()=>pending.promise});
  const opening=panel.open();assert.equal(opened,1);f.document.dispatch('keydown',{key:'Escape'});pending.resolve({});await opening;assert.equal(panel.active,false);assert.equal(f.root.hidden,true);panel.destroy();
});
test('instance strip uses shared today summary and technical daily bars and host callback', () => {
  const f=fixture();let opened=0;const summary={today:{total:5},sevenDay:{total:9},daily:[{at:'day',total:9}]};
  instanceStrip(f.root,{instance:{},rows:[]},{...f,costSummary:summary,onHost:()=>opened++,level:'technical'});
  assert.ok(f.root.textContent.includes('$5.00'));assert.ok(f.root.textContent.includes('$9.00'));allNodes(f.root).find(n=>n.id==='wb-host-open').dispatch('click');assert.equal(opened,1);
  instanceStrip(f.root,{instance:{},rows:[]},{...f,costSummary:{today:{total:0.0819},sevenDay:{total:0.5},daily:[]}});assert.ok(f.root.textContent.includes('$0.0819'),'small costs keep their precision');
});
test('view detail changes redraw existing usage without another read', async () => {
  const f=fixture();let reads=0,level='plain'; const page=createUsagePage({...f,detail:()=>level,read:async()=>{reads++;return value;}});
  await page.open();assert.equal(f.configs.length,2);level='technical';page.setViewDetail();assert.equal(reads,1);assert.equal(f.configs.length,6);assert.equal(f.destroyed(),2);page.destroy();assert.equal(f.destroyed(),6);
});
test('failed usage read clears earlier values and hides raw errors in plain view', async () => {
  const f=fixture();let fail=false;const page=createUsagePage({...f,read:async()=>{if(fail)throw Error('private failure');return value;}});
  await page.open();assert.ok(f.root.textContent.includes('$5.00'));fail=true;await page.refresh();assert.equal(f.root.textContent.includes('$5.00'),false);assert.ok(f.root.textContent.includes('wb.readFailed'));assert.equal(f.root.textContent.includes('private failure'),false);page.destroy();
});

test('usage keeps a newer successful result when an older read fails late', async () => {
  const f = fixture(), older = deferred(); let reads = 0;
  const page = createUsagePage({ ...f, read: () => ++reads === 1 ? older.promise : Promise.resolve(value) });
  const opening = page.open();
  await page.refresh();
  assert.ok(f.root.textContent.includes('$5.00'));
  older.reject(Error('old failure')); await opening;
  assert.ok(f.root.textContent.includes('$5.00'));
  assert.equal(f.root.textContent.includes('wb.readFailed'), false);
  assert.equal(allNodes(f.root).find(node => node.id === 'wb-usage-status').textContent, '');
  page.destroy();
});

test('host range changes keep the newer range when an older response arrives late', async () => {
  const f = fixture(), older = deferred(), newer = deferred(), paths = [];
  const panel = createHostPanel({ ...f, detail: () => 'technical', read: path => {
    paths.push(path); return paths.length === 1 ? older.promise : newer.promise;
  } });
  const opening = panel.open();
  const range = allNodes(f.root).find(node => node.id === 'wb-host-range');
  range.children.find(button => button.dataset.range === '24h').dispatch('click');
  assert.deepEqual(paths, ['/api/workbench/host?range=6h', '/api/workbench/host?range=24h']);
  newer.resolve({ current: { cpu_pct: 24 }, series: [{ at: '2026-11-01T00:00:00Z', cpu: { avg: 24, max: 24 } }] });
  await tick();
  assert.ok(f.root.textContent.includes('24.0%'));
  older.resolve({ current: { cpu_pct: 6 }, series: [{ at: '2026-11-01T00:00:00Z', cpu: { avg: 6, max: 6 } }] });
  await opening;
  assert.ok(f.root.textContent.includes('24.0%'));
  assert.equal(f.root.textContent.includes('6.0%'), false);
  assert.equal(allNodes(f.root).find(node => node.id === 'wb-host-range').children.find(button => button.attributes['aria-pressed'] === 'true').dataset.range, '24h');
  assert.deepEqual(f.configs.at(-3).data.datasets[0].data, [24]);
  panel.destroy();
});

test('host keeps a newer successful result when an older read fails late', async () => {
  const f = fixture(), older = deferred(); let reads = 0;
  const panel = createHostPanel({ ...f, read: () => ++reads === 1 ? older.promise : Promise.resolve({ current: { cpu_pct: 22 } }) });
  const opening = panel.open(); await panel.refresh();
  older.reject(Error('old failure')); await opening;
  assert.ok(f.root.textContent.includes('22.0%'));
  assert.equal(f.root.textContent.includes('wb.readFailed'), false);
  assert.equal(f.root.hidden, false);
  panel.destroy();
});

test('technical usage renders unavailable runtime history as unknown instead of zero charts', () => {
  const f = fixture();
  const unknown = { ...value, runtimeEventsUnknown: true, rotations: null, tools: null,
    totals: { ...value.totals, rotations: null, tools: null } };
  const view = renderUsage(f.root, unknown, { ...f, level: 'technical' });
  assert.equal(f.configs.length, 3);
  const unavailable = allNodes(f.root).filter(node => node.tagName === 'SECTION' &&
    ['wb.usage.rotations', 'wb.usage.tools'].includes(node.children[0]?.textContent));
  assert.equal(unavailable.length, 2);
  for (const card of unavailable) assert.equal(card.children[1].textContent, 'wb.unknown');
  const totals = allNodes(f.root).find(node => node.classList.contains('wb-usage-totals'));
  for (const title of ['wb.usage.rotations', 'wb.usage.tools']) {
    const total = totals.children.find(node => node.children[0].textContent === title);
    assert.equal(total.children[1].textContent, 'wb.unknown');
  }
  view.destroy(); assert.equal(f.destroyed(), 3);
});


test('message counts distinguish unreadable and zero in both locales and detail levels', () => {
  const sampledAt = '2026-11-06T04:00:00.000Z';
  for (const locale of ['en', 'zh']) {
    const pack = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    const t = key => pack[key] ?? key;
    assert.equal(formatUsageCount(null, t), locale === 'zh' ? '未知' : 'Unknown');
    assert.equal(formatUsageCount(0, t), '0');
    for (const level of ['plain', 'technical']) {
      const f = fixture(), failed = { ...value, messagesReason: 'messages_unreadable', messagesSampledAt: sampledAt,
        messages: value.buckets.map(at => ({ at, in: null, out: null })), totals: { ...value.totals, messages: { in: null, out: null } } };
      const view = renderUsage(f.root, failed, { ...f, t, level });
      const totals = allNodes(f.root).find(node => node.classList.contains('wb-usage-totals'));
      // Sent messages sit under the received count in the same summary box.
      const box = totals.children.find(node => node.children[0].textContent === t('wb.usage.received'));
      assert.equal(box.children[1].textContent, t('wb.unknown'));
      assert.equal(box.children[2].textContent, `${t('wb.usage.sent')} ${t('wb.unknown')}`);
      assert.equal(f.root.textContent.includes('messages_unreadable'), level === 'technical');
      assert.equal(f.root.textContent.includes(sampledAt), level === 'technical');
      assert.equal(f.configs.length, level === 'technical' ? 3 : 1);
      assert.equal(f.root.textContent.includes('$5.00'), true);
      view.destroy();
      const empty = fixture();
      renderUsage(empty.root, { ...value, messagesReason: null, messages: value.buckets.map(at => ({ at, in: 0, out: 0 })),
        totals: { ...value.totals, messages: { in: 0, out: 0 } } }, { ...empty, t, level });
      const emptyTotals = allNodes(empty.root).find(node => node.classList.contains('wb-usage-totals'));
      const emptyBox = emptyTotals.children.find(node => node.children[0].textContent === t('wb.usage.received'));
      assert.equal(emptyBox.children[1].textContent, '0');
      assert.equal(emptyBox.children[2].textContent, `${t('wb.usage.sent')} 0`);
      const messageChart = empty.configs[1];
      assert.deepEqual(messageChart.data.datasets.map(row => row.data), [[0, 0], [-0, -0]]);
    }
  }
});

test('host curves keep a legend, a labelled 0–100% axis and a readable height, and the header names core', () => {
  const f=fixture(),data={current:{cpu_pct:10},pm2:{online:1,total:1},series:[{at:'2026-11-01T00:00:00Z',cpu:{avg:10,max:40},mem:null,disk:null}]};
  const view=renderHost(f.root,data,{...f,level:'technical',meta:{name:'spark',mode:'multi',core:'core 0.9.4',version:'dashboard 0.7.0'}});
  const nodes=[];const walk=n=>{nodes.push(n);(n.children??[]).forEach(walk);};walk(f.root);
  assert.ok(nodes.some(n=>n.classList?.contains('wb-host-legend')),'avg and max lines are named once for the stack');
  assert.match(f.root.textContent,/spark · multi · core 0\.9\.4 · dashboard 0\.7\.0/);
  const y=f.configs[0].options.scales.y;assert.notEqual(y.ticks.display,false);assert.equal(y.ticks.callback(50),'50%');
  assert.ok(nodes.filter(n=>n.classList?.contains('wb-host-frame')).every(n=>parseInt(n.style.height)>=100));
  assert.doesNotMatch(String(f.configs[0].data.datasets[0].backgroundColor),/22$/,'no hex+alpha concatenation');
  view.destroy();
});

test('on phones the custom dates fold behind the last range button, which opens them without reading', async () => {
  const f = fixture(), paths = [];
  const page = createUsagePage({ ...f, read: async path => { paths.push(path); return value; } });
  await page.open();
  const nodes = allNodes(f.root), controls = nodes.find(node => node.classList.contains('wb-usage-controls'));
  const seg = nodes.find(node => node.id === 'wb-usage-range'), toggle = seg.children.at(-1), custom = nodes.find(node => node.id === 'wb-usage-custom');
  assert.equal(toggle.textContent, 'wb.usage.range.custom'); assert.equal(toggle.attributes['aria-controls'], 'wb-usage-custom');
  assert.deepEqual(custom.children.filter(node => node.tagName === 'BUTTON').map(node => node.id), ['wb-usage-apply'], 'Apply sits with the dates');
  assert.equal(toggle.attributes['aria-expanded'], 'false'); assert.equal(controls.classList.contains('wb-usage-custom-open'), false);
  const reads = paths.length;
  toggle.dispatch('click');
  assert.equal(toggle.attributes['aria-expanded'], 'true'); assert.equal(controls.classList.contains('wb-usage-custom-open'), true);
  assert.equal(paths.length, reads, 'opening the fold reads nothing');
  toggle.dispatch('click'); assert.equal(controls.classList.contains('wb-usage-custom-open'), false);
  nodes.find(node => node.id === 'wb-usage-since').value = '2026-11-01T00:00';
  nodes.find(node => node.id === 'wb-usage-until').value = '2026-11-03T00:00';
  toggle.dispatch('click'); nodes.find(node => node.id === 'wb-usage-apply').dispatch('click'); await tick();
  assert.match(paths.at(-1), /since=/);
  toggle.dispatch('click');
  assert.equal(controls.classList.contains('wb-usage-custom-open'), true, 'an applied custom range keeps its dates in view');
  assert.equal(toggle.classList.contains('wb-on'), true);
  page.destroy();
});

test('range buttons and the always-visible custom dates choose what is read', async () => {
  const f = fixture(), paths = [];
  const page = createUsagePage({ ...f, read: async path => { paths.push(path); return value; } });
  await page.open();
  const nodes = allNodes(f.root), pressed = () => nodes.find(node => node.id === 'wb-usage-range').children
    .filter(node => node.attributes['aria-pressed'] === 'true').map(node => node.dataset.range);
  assert.deepEqual(pressed(), ['7d']);
  nodes.find(node => node.dataset.range === '24h').dispatch('click'); await tick();
  assert.match(paths.at(-1), /range=24h$/); assert.deepEqual(pressed(), ['24h']);
  // The visible field shows the page-language label until a time is chosen, then the chosen time.
  const shown = () => nodes.filter(node => node.classList.contains('wb-date-text')).map(node => node.textContent);
  assert.deepEqual(shown(), ['wb.usage.since', 'wb.usage.until']);
  const since = nodes.find(node => node.id === 'wb-usage-since');
  since.value = '2026-11-01T00:00'; since.dispatch('input');
  nodes.find(node => node.id === 'wb-usage-until').value = '2026-11-03T00:00';
  assert.deepEqual(shown(), ['2026-11-01 00:00', 'wb.usage.until']);
  nodes.find(node => node.id === 'wb-usage-apply').dispatch('click'); await tick();
  assert.match(paths.at(-1), /range=custom&since=.*&until=/); assert.deepEqual(pressed(), []);
  assert.deepEqual(shown(), ['2026-11-01 00:00', '2026-11-03 00:00']);
  page.destroy();
});

test('axis labels are short dates with today named, or clock hours', () => {
  const now = Date.parse('2026-11-03T05:00:00Z');
  assert.deepEqual(bucketLabels(['2026-11-01T16:00:00.000Z', '2026-11-02T16:00:00.000Z'], { tz: 'Asia/Singapore', now, t: key => key }),
    ['11-02', 'wb.usage.today']);
  assert.deepEqual(bucketLabels(['2026-11-03T01:00:00.000Z'], { tz: 'Asia/Singapore', bucket: 'hour', now }), ['09:00']);
  assert.equal(compactCount(215000000), '215M'); assert.equal(compactCount(8400), '8,400'); assert.equal(compactCount(84000), '84K');
});

test('technical usage reads the cache hit rate for the same period and shows it under tokens', async () => {
  const f = fixture(), paths = []; let level = 'plain', cache = { total: 0.623 };
  const reply = { ...value, since: '2026-11-01T00:00:00.000Z', until: '2026-11-08T00:00:00.000Z' };
  const page = createUsagePage({ ...f, detail: () => level, t: (key, params) => key + (params ? ' ' + JSON.stringify(params) : ''),
    read: async path => { paths.push(path); if (path.startsWith('/api/metrics/series')) { if (!cache) throw Error('read_failed'); return cache; } return reply; } });
  await page.open();
  assert.deepEqual(paths, ['/api/workbench/usage?range=7d'], 'plain view has no token total and reads no hit rate');
  level = 'technical'; page.setViewDetail(); await tick();
  assert.equal(paths[1], cachePath(reply));
  assert.match(paths[1], /metric=cache&since=2026-11-01T00%3A00%3A00\.000Z&until=2026-11-08T00%3A00%3A00\.000Z/);
  assert.match(f.root.textContent, /wb\.usage\.cacheHit \{"pct":62\}/);
  page.setViewDetail(); await tick();
  assert.equal(paths.length, 2, 'a known rate is not read again');
  cache = null; await page.refresh(); await tick();
  assert.equal(f.root.textContent.includes('wb.usage.cacheHit'), false, 'an unreadable rate leaves the line out');
  page.destroy();
});
test('beyond the seven days of runtime events the unknown cards take full rows and tokens fills its row', () => {
  const f = fixture();
  renderUsage(f.root, { ...value, rotations: null, tools: null }, { ...f, level: 'technical' });
  const cards = allNodes(f.root).filter(node => node.classList.contains('wb-usage-chart'));
  const unknown = cards.filter(node => node.classList.contains('wb-usage-unknown'));
  assert.equal(unknown.length, 2);
  assert.ok(unknown.every(node => node.classList.contains('wb-usage-wide')));
  const tokens = cards.find(node => node.textContent.includes('wb.usage.tokens'));
  assert.ok(tokens.classList.contains('wb-usage-wide'));
  const cost = cards.find(node => node.textContent.includes('wb.usage.cost'));
  assert.equal(cost.classList.contains('wb-usage-wide'), false);
});

test('the usage page starts with its range controls; the nav button says which page is current', async () => {
  const f = fixture();
  const page = createUsagePage({ ...f, read: async () => value });
  await page.open();
  assert.equal(f.root.children[0].classList.contains('wb-usage-controls'), true);
  assert.equal(allNodes(f.root).some(node => /^H[12]$/.test(node.tagName)), false, 'no page heading repeats the nav');
  assert.equal(allNodes(f.root).some(node => node.textContent === 'wb.nav.usage'), false);
  page.destroy();
  const tabs = ['overview', 'trends', 'settings'].map(name => { const tab = f.document.createElement('button'); tab.dataset.tab = name; return tab; });
  tabs[0].setAttribute('aria-current', 'page');
  markCurrentTab(tabs, 'trends');
  assert.deepEqual(tabs.map(tab => tab.attributes['aria-current'] ?? null), [null, 'page', null]);
  markCurrentTab(tabs, 'settings');
  assert.deepEqual(tabs.map(tab => tab.attributes['aria-current'] ?? null), [null, null, 'page']);
});
