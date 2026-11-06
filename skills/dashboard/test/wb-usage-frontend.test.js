import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createDocument, allNodes, deferred, tick, Node } from './fixtures/workbench-dom.js';
import { renderUsage, createUsagePage, usagePath, formatUsageCount } from '../public/js/wb/usage.js';
import { renderHost, createHostPanel } from '../public/js/wb/host-panel.js';
import { instanceStrip } from '../public/js/wb/instance-strip.js';

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
  tokensByRuntime:[], messages:[{at:'2026-11-01T16:00:00.000Z',in:4,out:2}], rotations:[], tools:[{name:'Read',count:8}], projects:{items:[{name:'example',outputTokens:91}]},
};
test('usage plain view shows costs and signed messages with runtime stacks and tables', () => {
  const f=fixture(); const view=renderUsage(f.root,value,f);
  assert.equal(f.configs.length,2); assert.equal(f.configs[0].options.scales.x.stacked,true);
  assert.deepEqual(f.configs[0].data.datasets.map(d=>d.data),[[2,0],[0,3]]);
  assert.deepEqual(f.configs[1].data.datasets[1].data,[-2,-0]);
  assert.equal(f.root.textContent.includes('wb.usage.tokens'),false);
  assert.equal(allNodes(f.root).filter(n=>n.tagName==='TABLE').length,2);
  assert.ok(f.configs.every(c=>c.options.plugins.legend.display));
  view.destroy(); assert.equal(f.destroyed(),2);
});
test('technical usage adds tokens rotations tools and output token projects without quotas', () => {
  const f=fixture(); renderUsage(f.root,value,{...f,level:'technical'});
  assert.equal(f.configs.length,6); assert.deepEqual(f.configs[5].data.labels,['example']);
  assert.deepEqual(f.configs[5].data.datasets[0].data,[91]);
  assert.equal(f.root.textContent.includes('quota'),false);
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
  await page.open(); const range=allNodes(f.root).find(n=>n.id==='wb-usage-range');range.value='custom';range.dispatch('change');
  allNodes(f.root).find(n=>n.id==='wb-usage-apply').dispatch('click');await tick();assert.equal(reads,1);
  assert.ok(f.root.textContent.includes('wb.usage.invalidRange'));assert.match(usagePath({range:'custom',since:'a',until:'b'}),/since=a&until=b/);page.destroy();
});
test('custom usage rejects a range longer than the allowed year before reading', async () => {
  const f = fixture(); let reads = 0;
  const page = createUsagePage({ ...f, read: async () => { reads++; return value; } });
  await page.open();
  const nodes = allNodes(f.root), range = nodes.find(node => node.id === 'wb-usage-range');
  range.value = 'custom'; range.dispatch('change');
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
test('host close callback Escape and late reads preserve lifecycle', async () => {
  const f=fixture(),pending=deferred();let opened=0;const panel=createHostPanel({...f,onOpen:()=>opened++,read:()=>pending.promise});
  const opening=panel.open();assert.equal(opened,1);f.document.dispatch('keydown',{key:'Escape'});pending.resolve({});await opening;assert.equal(panel.active,false);assert.equal(f.root.hidden,true);panel.destroy();
});
test('instance strip uses shared today summary and technical daily bars and host callback', () => {
  const f=fixture();let opened=0;const summary={today:{total:5},sevenDay:{total:9},daily:[{at:'day',total:9}]};
  instanceStrip(f.root,{instance:{},rows:[]},{...f,costSummary:summary,onHost:()=>opened++,level:'technical'});
  assert.ok(f.root.textContent.includes('$5.0000'));assert.ok(f.root.textContent.includes('$9.0000'));allNodes(f.root).find(n=>n.id==='wb-host-open').dispatch('click');assert.equal(opened,1);
});
test('view detail changes redraw existing usage without another read', async () => {
  const f=fixture();let reads=0,level='plain'; const page=createUsagePage({...f,detail:()=>level,read:async()=>{reads++;return value;}});
  await page.open();assert.equal(f.configs.length,2);level='technical';page.setViewDetail();assert.equal(reads,1);assert.equal(f.configs.length,8);assert.equal(f.destroyed(),2);page.destroy();assert.equal(f.destroyed(),8);
});
test('failed usage read clears earlier values and hides raw errors in plain view', async () => {
  const f=fixture();let fail=false;const page=createUsagePage({...f,read:async()=>{if(fail)throw Error('private failure');return value;}});
  await page.open();assert.ok(f.root.textContent.includes('$5.0000'));fail=true;await page.refresh();assert.equal(f.root.textContent.includes('$5.0000'),false);assert.ok(f.root.textContent.includes('wb.readFailed'));assert.equal(f.root.textContent.includes('private failure'),false);page.destroy();
});

test('usage keeps a newer successful result when an older read fails late', async () => {
  const f = fixture(), older = deferred(); let reads = 0;
  const page = createUsagePage({ ...f, read: () => ++reads === 1 ? older.promise : Promise.resolve(value) });
  const opening = page.open();
  await page.refresh();
  assert.ok(f.root.textContent.includes('$5.0000'));
  older.reject(Error('old failure')); await opening;
  assert.ok(f.root.textContent.includes('$5.0000'));
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
  range.value = '24h'; range.dispatch('change');
  assert.deepEqual(paths, ['/api/workbench/host?range=6h', '/api/workbench/host?range=24h']);
  newer.resolve({ current: { cpu_pct: 24 }, series: [{ at: '2026-11-01T00:00:00Z', cpu: { avg: 24, max: 24 } }] });
  await tick();
  assert.ok(f.root.textContent.includes('24.0%'));
  older.resolve({ current: { cpu_pct: 6 }, series: [{ at: '2026-11-01T00:00:00Z', cpu: { avg: 6, max: 6 } }] });
  await opening;
  assert.ok(f.root.textContent.includes('24.0%'));
  assert.equal(f.root.textContent.includes('6.0%'), false);
  assert.equal(allNodes(f.root).find(node => node.id === 'wb-host-range').value, '24h');
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
  assert.equal(f.configs.length, 4);
  const unavailable = allNodes(f.root).filter(node => node.tagName === 'SECTION' &&
    ['wb.usage.rotations', 'wb.usage.tools'].includes(node.children[0]?.textContent));
  assert.equal(unavailable.length, 2);
  for (const card of unavailable) assert.equal(card.children[1].textContent, 'wb.unknown');
  const totals = allNodes(f.root).find(node => node.classList.contains('wb-usage-totals'));
  for (const title of ['wb.usage.rotations', 'wb.usage.tools']) {
    const total = totals.children.find(node => node.children[0].textContent === title);
    assert.equal(total.children[1].textContent, 'wb.unknown');
  }
  assert.ok(f.configs.every(config => config.options.plugins.legend.display));
  view.destroy(); assert.equal(f.destroyed(), 4);
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
      for (const key of ['wb.usage.received', 'wb.usage.sent']) {
        const box = totals.children.find(node => node.children[0].textContent === t(key));
        assert.equal(box.children[1].textContent, t('wb.unknown'));
      }
      assert.equal(f.root.textContent.includes('messages_unreadable'), level === 'technical');
      assert.equal(f.root.textContent.includes(sampledAt), level === 'technical');
      assert.equal(f.configs.length, level === 'technical' ? 5 : 1);
      assert.equal(f.root.textContent.includes('$5.0000'), true);
      view.destroy();
      const empty = fixture();
      renderUsage(empty.root, { ...value, messagesReason: null, messages: value.buckets.map(at => ({ at, in: 0, out: 0 })),
        totals: { ...value.totals, messages: { in: 0, out: 0 } } }, { ...empty, t, level });
      const emptyTotals = allNodes(empty.root).find(node => node.classList.contains('wb-usage-totals'));
      for (const key of ['wb.usage.received', 'wb.usage.sent']) {
        const box = emptyTotals.children.find(node => node.children[0].textContent === t(key));
        assert.equal(box.children[1].textContent, '0');
      }
      const messageChart = empty.configs[1];
      assert.deepEqual(messageChart.data.datasets.map(row => row.data), [[0, 0], [-0, -0]]);
    }
  }
});
