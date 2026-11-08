import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { createRuns } from '../src/lib/workbench/runs.js';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
import { createTimelineLoader, renderTimeline } from '../public/js/wb/detail-timeline.js';
import { createGroupDetail } from '../public/js/wb/detail.js';

// Boundary: a real Store (private SQLite in a temporary directory) and the real run listing answer the
// timeline and run reads; the real loader, group detail and renderers draw into an injected DOM. The
// /api/timeline route's own parameter parsing is covered by core-log-http.test.js and the runs route's by
// wb-detail-http.test.js; here a read passes the same parameters to store.queryEvents / createRuns.
// Run for timeline filtering, counting or ordering changes. No network, child process or timer; the
// temporary directory is removed after each case.
const GROUP = 'telegram:a', RUN = 'run-a';
const tr = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
const at = seconds => new Date(Date.parse('2026-11-08T10:00:00.000Z') + seconds * 1000).toISOString();

// One run: a few events a person can follow, then 600 router `release` diagnostics, then the turn ends.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-timeline-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let seq = 0;
  const put = (type, seconds, category = 'lifecycle') => {
    const id = `event-${++seq}`;
    store.insertEvent({ id, ingest_id: id, timestamp: at(seconds), runtime: 'claude', run_id: RUN, session_group: GROUP,
      event_type: type, category, metadata: {}, source: 'core-log' });
  };
  store.db.transaction(() => {
    put('session_start', 0); put('user_prompt_submit', 1); put('pre_tool_use', 2, 'tool'); put('post_tool_use', 3, 'tool');
    for (let i = 0; i < 600; i++) put('release', 4 + i * 0.1, 'diagnostic');
    put('stop', 70, 'turn');
  })();
  const runs = createRuns({ store, getSnapshot: async () => ({ rows: [{ sessionGroup: GROUP, live: { runId: RUN } }] }) });
  const reads = [];
  async function read(pathname) {
    const url = new URL(pathname, 'http://fixture'), params = url.searchParams;
    reads.push(url);
    const types = params.get('types')?.split(',').filter(Boolean) || undefined;
    if (url.pathname === '/api/timeline') {
      const afterSeq = Number(params.get('after_seq'));
      return { events: store.queryEvents({ types, sessionGroup: params.has('session_group') ? params.get('session_group') || null : undefined,
        runId: params.get('run_id') || undefined, afterSeq, order: params.get('order') === 'desc' ? 'desc' : 'asc',
        limit: Math.min(1000, Number(params.get('limit') ?? 100)) }) };
    }
    if (url.pathname.endsWith('/runs')) return runs(GROUP, { limit: Number(params.get('limit') ?? 3), types,
      ...(params.has('before') ? { before: params.get('before') } : {}) });
    if (url.pathname.endsWith('/messages')) return { messages: [] };
    if (url.pathname.endsWith('/backlog')) return { count: 0, firstAt: null, syncing: false };
    throw new Error('unexpected read ' + url.pathname);
  }
  return { store, read, reads };
}
const labels = root => allNodes(root).filter(node => node.classList.contains('wb-ev-t')).map(node => node.text ?? '');
const repeats = root => allNodes(root).filter(node => node.classList.contains('wb-ev-rep')).map(node => node.textContent);

test('600 release diagnostics: plain view shows only the plain events newest first, technical view merges them into one row', async t => {
  const f = fixture(t);
  let level = 'plain';
  const loader = createTimelineLoader({ request: f.read, detail: () => level, now: () => Date.parse(at(80)) });
  await loader.open(GROUP, RUN);
  const eventReads = f.reads.filter(url => url.pathname === '/api/timeline');
  assert.equal(eventReads.length, 1, 'the plain events fit one page: the server filtered the diagnostics out');
  assert.equal(eventReads[0].searchParams.get('types').split(',').includes('release'), false);
  assert.equal(loader.state.events.get(RUN).length, 5);
  assert.equal(loader.state.totalEvents, 5, 'counts cover the events the plain view shows');
  assert.equal(loader.state.runs[0].n, 5);
  const document = createDocument(), root = document.createElement('div');
  renderTimeline(root, loader, { document, t: tr, level });
  assert.deepEqual(labels(root), ['wb.event.stop', 'wb.event.post_tool_use', 'wb.event.pre_tool_use', 'wb.event.user_prompt_submit', 'wb.event.session_start'],
    'newest first inside the run');
  assert.doesNotMatch(root.textContent, /release|wb\.event\.category\.diagnostic/);
  assert.deepEqual(repeats(root), []);

  level = 'technical';
  f.reads.length = 0;
  await loader.setLevel();
  const technicalReads = f.reads.filter(url => url.pathname === '/api/timeline');
  assert.equal(technicalReads.every(url => !url.searchParams.has('types')), true, 'technical view reads every type');
  assert.equal(loader.state.events.get(RUN).length, 605);
  assert.equal(loader.state.totalEvents, 605);
  assert.equal(loader.state.runs[0].n, 605);
  renderTimeline(root, loader, { document, t: tr, level });
  assert.deepEqual(labels(root), ['stop', 'release', 'post_tool_use', 'pre_tool_use', 'user_prompt_submit', 'session_start'],
    'the 600 releases are one row, between the events around them');
  const short = value => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  assert.deepEqual(repeats(root), [tr('wb.timeline.repeated', { count: 600, from: short(at(4)), to: short(at(4 + 599 * 0.1)) })]);

  level = 'plain';
  await loader.setLevel();
  renderTimeline(root, loader, { document, t: tr, level });
  assert.equal(labels(root).length, 5, 'switching back rereads the plain events only');
  assert.equal(loader.state.totalEvents, 5);
  loader.close();
});

test('recent activity is not taken over by diagnostics and follows the technical detail switch', async t => {
  const f = fixture(t);
  let level = 'plain';
  const document = createDocument(), root = document.createElement('aside');
  const fetch = async pathname => ({ ok: true, status: 200, json: async () => f.read(pathname) });
  const detail = createGroupDetail({ root, document, fetch, t: tr, detail: () => level, now: () => Date.parse(at(80)) });
  t.after(() => detail.destroy());
  const row = { sessionGroup: GROUP, presence: 'running', state: { kind: 'idle' }, live: { runId: RUN, sessionId: 's' }, tools: [],
    queue: { pending: { count: 0 }, running: { count: 0 } }, contextPct: 10, createdAt: 1000, launchConfig: { runtime: 'claude', mode: 'default' } };
  await detail.open(row, { rows: [row], listKnown: true });
  const recent = () => allNodes(root).find(node => node.classList.contains('wb-detail-recent'));
  assert.deepEqual(labels(recent()), ['wb.event.stop', 'wb.event.post_tool_use', 'wb.event.pre_tool_use', 'wb.event.user_prompt_submit', 'wb.event.session_start']);
  assert.match(root.textContent, /wb\.detail\.fullTimeline \{"events":5,"runs":1\}/);

  level = 'technical';
  f.reads.length = 0;
  detail.setViewDetail();
  await new Promise(resolve => setImmediate(resolve));
  await detail.refresh();
  const recentRead = f.reads.find(url => url.pathname === '/api/timeline' && url.searchParams.get('limit') === '5');
  assert.ok(recentRead, 'switching to technical detail rereads recent activity');
  assert.equal(recentRead.searchParams.has('types'), false);
  assert.deepEqual(labels(recent()), ['stop', 'release'], 'the four newest releases are one row');
  assert.deepEqual(repeats(recent()).length, 1);
  assert.match(root.textContent, /wb\.detail\.fullTimeline \{"events":605,"runs":1\}/);
});
