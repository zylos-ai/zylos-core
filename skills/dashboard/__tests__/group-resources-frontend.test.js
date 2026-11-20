import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readGroupSnapshot, groupSnapshot, instanceActionRequest } from '../public/js/wb/group-data.js';

import { formatZoned } from '../public/js/wb/instance-zone.js?v=100';
import { createDocument } from './fixtures/workbench-dom.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { statePill, renderDistribution, modelCell, renderRow } = await import('../public/js/wb/board.js');
const { renderAttention } = await import('../public/js/wb/attention-bar.js');
const { systemItems, instanceStrip } = await import('../public/js/wb/instance-strip.js');

// Pure page modules and injected reads/DOM: no process, database, network or source evaluation.
test('group page requests running rows and counts separately without fetching offline rows', async () => {
  const paths = [], instance = { default_runtime: 'codex', session_mode: { sessionMode: 'multi' }, accounts: {}, resources: {} };
  const counts = { readAt: 123, running: { total: 1, states: { working: 1 } }, offline: { total: 50 }, pool: { used: 1, capacity: 3 } };
  const row = { id: 'example', displayName: 'Example', channel: 'telegram', runtime: 'codex', model: 'example', duration: 100, mainAgent: 'working', contextPct: 25, lastActivityAt: 123, state: { kind: 'working' }, flags: { queued: { count: 3 } } };
  const snapshot = await readGroupSnapshot(async path => { paths.push(path); return path === '/api/instance' ? instance : path === '/api/groups/counts' ? counts : { readAt: 123, rows: [row] }; });
  assert.deepEqual(paths.sort(), ['/api/groups/counts', '/api/groups/running', '/api/instance']);
  assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0].sessionGroup, row.id ?? row.sessionGroup);
  assert.equal(snapshot.groupCounts.offline.total, 50); assert.equal(snapshot.instance.pool, counts.pool);
});
test('offline page keeps its returned cursor and does not request running rows', async () => {
  const paths = [];
  const snapshot = await readGroupSnapshot(async path => { paths.push(path); return path === '/api/instance' ? {} : path === '/api/groups/counts' ? {} : { rows: [], nextCursor: 'later' }; }, { side: 'offline', cursor: 'earlier' });
  assert.equal(paths.includes('/api/groups/offline?cursor=earlier'), true);
  assert.equal(paths.includes('/api/groups/running'), false);
  assert.equal(snapshot.nextCursor, 'later'); assert.equal(snapshot.hasOlder, true);
});
test('working primary state and queued blocked flags are displayed together without main-agent state', () => {
  const document = createDocument();
  const pill = statePill(document, { state: { kind: 'working' }, mainAgent: 'idle', flags: { queued: { count: 3 }, blocked: { reason: 'rate_limited' } } });
  assert.match(pill.textContent, /wb.state.working/); assert.match(pill.textContent, /wb.flags.queued/); assert.match(pill.textContent, /wb.flags.blocked/);
  assert.equal(pill.textContent.includes('idle'), false);
});
test('instance defaults and actions target their owning resource with the prescribed method', () => {
  assert.deepEqual(instanceActionRequest('switch-model', { runtime: 'codex', model: 'example' }), { method: 'PUT', path: '/api/instance/defaults', body: { runtime: 'codex', model: 'example', kind: 'model' } });
  assert.equal(instanceActionRequest('restart-session').path, '/api/groups/origin/actions/restart');
  assert.equal(instanceActionRequest('upgrade-cc').path, '/api/instance/actions/upgrade-runtime');
  assert.throws(() => instanceActionRequest('made-up'), /unknown_action/);
});

test('a default launch displays the validated actual model from its group row', () => {
  assert.equal(modelCell({ presence: 'running', model: 'actual-model', launchConfig: { runtime: 'codex', mode: 'default' } }), 'Codex · actual-model');
});
test('refreshing an offline list rereads the loaded page depth and retains later rows', async () => {
  let generation = 0; const calls = [];
  const read = async path => {
    calls.push(path);
    if (path === '/api/instance') return {};
    if (path === '/api/groups/counts') return { listKnown: true };
    return path.includes('cursor=second') ? { rows: [{ id: 'second', displayName: 'Second', channel: 'dashboard', lastActivityAt: 1, flags: {} }], nextCursor: null }
      : { listKnown: true, rows: [{ id: 'first', displayName: String(generation), channel: 'dashboard', lastActivityAt: 2, flags: {} }], nextCursor: 'second' };
  };
  const first = await readGroupSnapshot(read, { side: 'offline', pages: 2 });
  generation++;
  const refreshed = await readGroupSnapshot(read, { side: 'offline', pages: 2 });
  assert.equal(first.rows.length, 2); assert.equal(refreshed.rows.length, 2);
  assert.equal(refreshed.rows[0].name.displayName, '1'); assert.equal(refreshed.rows[1].sessionGroup, 'second');
  assert.equal(calls.filter(path => path.includes('cursor=second')).length, 2);
});

test('pushed counts and the current instance refresh only the group rows', async () => {
  const paths = [], counts = { running: { total: 1 }, offline: { total: 500 }, pool: { used: 1, capacity: 4 } };
  const instance = { default_runtime: 'codex' };
  const row = { id: 'a', displayName: 'A', channel: 'telegram', runtime: 'codex', model: 'example', duration: 100, mainAgent: 'working', contextPct: 25, lastActivityAt: 123, state: { kind: 'working' } };
  const snapshot = await readGroupSnapshot(async path => { paths.push(path); return { rows: [row] }; }, { counts, instance });
  assert.deepEqual(paths, ['/api/groups/running']);
  assert.equal(snapshot.groupCounts, counts);
  assert.equal(snapshot.rows[0].sessionGroup, row.id ?? row.sessionGroup);
  assert.equal(snapshot.instance.pool, counts.pool);
  assert.equal(Object.hasOwn(snapshot.instance, 'poolCapacityRecord'), false);
  assert.equal(Object.hasOwn(snapshot.instance.pool, 'capacityRecord'), false);
});

const compactRunning = (id, flags = {}, runtime = 'codex') => ({ id, displayName: 'Name ' + id, channel: 'telegram', runtime, model: 'model', state: { kind: 'working' }, duration: 5, flags, mainAgent: 'working', contextPct: 20, lastActivityAt: 1 });
const compactOffline = (id, flags = {}) => ({ id, displayName: 'Offline ' + id, channel: 'telegram', lastActivityAt: 1, flags });

test('canonical minimal rows compose attention from independent instance, counts and detail-free lists', () => {
  const instance = { default_runtime: 'codex', session_mode: { sessionMode: 'multi', transition: null, globalGate: null, blocked: false, supervisor: 'reachable', lastCompleted: null, lastEvents: [] },
    supervisorPaused: true, runtimeHealth: { codex: { health: 'auth_failed' }, claude: { health: 'rate_limited', cooldownUntil: 1234 } },
    services: { online: 1, total: 2, channels: [{ channel: 'telegram', service: 'zylos-telegram', status: 'stopped', restarts10m: 3, lastSendFailed: true, consecutiveFailures: 2 }] } };
  const counts = { listKnown: false, running: { total: 2, states: { working: 2 } }, offline: { total: 2, waitingSlot: 1, startFailed: 1 }, pool: { used: 2, capacity: 2 } };
  const snapshot = groupSnapshot(instance, counts, { rows: [compactRunning('one', { blocked: { reason: 'auth_failed' } }), compactRunning('two', { blocked: { reason: 'auth_failed' }, unreadable: { reasons: ['status'] } })],
    failedRows: [compactOffline('failed', { startFailed: { count: 2, lastAt: 42 }, unreadable: { reasons: ['launch'] } })] });
  assert.equal(snapshot.mode, 'multi'); assert.equal(snapshot.baselineRuntime, 'codex');
  assert.equal(snapshot.rows[0].sessionGroup, 'one'); assert.equal(snapshot.rows[0].name.displayName, 'Name one');
  assert.deepEqual(snapshot.attention.reminders.map(item => item.kind), ['supervisor_paused', 'rate_limited', 'pool_full']);
  const auth = snapshot.attention.problems.filter(item => item.kind === 'auth_failed');
  assert.equal(auth.length, 1); assert.deepEqual(auth[0].groups, ['one', 'two']);
  assert.deepEqual(snapshot.attention.problems.filter(item => item.kind === 'data_unreadable').map(item => item.reasonCode ?? item.source), ['status', 'launch', 'groups']);
  assert.equal(snapshot.attention.problems.find(item => item.kind === 'channel_send_failed').channel, 'telegram');
  assert.equal(snapshot.attention.problems.find(item => item.kind === 'start_failed').group, 'failed');
  const document = createDocument(), root = document.createElement('div'), selected = [];
  renderAttention(root, snapshot, { document, onSelect: id => selected.push(id) });
  assert.match(root.textContent, /Offline failed/);
  const failed = root.children.find(node => node.textContent.includes('Offline failed'));
  failed.dispatch('click'); assert.deepEqual(selected, ['failed']);
  const empty = groupSnapshot(instance, { ...counts, listKnown: true }, { rows: [] });
  assert.deepEqual(empty.attention.problems.find(item => item.kind === 'auth_failed').groups, [], 'account authentication remains visible with no running groups');
});

test('group snapshot shows older null and newer unreadable instance modes as unknown', () => {
  const counts = { listKnown: true, running: { total: 0, states: {} }, offline: { total: 0 }, pool: { used: 0, capacity: 2 } };
  for (const [sessionMode, view] of [['single', 'single'], [null, 'unreadable'], ['unreadable', 'unreadable']]) {
    const snapshot = groupSnapshot({ default_runtime: 'codex', session_mode: { sessionMode } }, counts, { rows: [] });
    assert.equal(snapshot.view, view, String(sessionMode));
    const document = createDocument(), root = document.createElement('div');
    instanceStrip(root, snapshot, { document, t: key => key, level: 'technical' });
    assert.equal(root.textContent.includes('wb.unknown'), view === 'unreadable', String(sessionMode));
  }
});

test('offline failure attention follows filtered pagination and normalizes only minimal rows', async () => {
  const paths = [], instance = { session_mode: { sessionMode: 'single' } };
  const counts = { offline: { startFailed: 2 } };
  const snapshot = await readGroupSnapshot(async path => {
    paths.push(path);
    if (path === '/api/groups/running') return { rows: [], listKnown: true };
    return path.includes('cursor=next') ? { rows: [compactOffline('b', { startFailed: { count: 2 } })], nextCursor: null }
      : { rows: [compactOffline('a', { startFailed: { count: 1 } })], nextCursor: 'next' };
  }, { instance, counts });
  assert.deepEqual(paths, ['/api/groups/running', '/api/groups/offline?flag=startFailed', '/api/groups/offline?flag=startFailed&cursor=next']);
  assert.equal(snapshot.mode, 'single'); assert.deepEqual(snapshot.attention.problems.map(item => item.group), ['a', 'b']);
  assert.equal(snapshot.failedRows[1].name.displayName, 'Offline b');
});

test('optional failure attention read errors preserve the list and report unreadable data', async () => {
  for (const repeatedCursor of [false, true]) {
    const snapshot = await readGroupSnapshot(async path => {
      if (path === '/api/groups/running') return { rows: [compactRunning('live')], listKnown: false };
      if (!repeatedCursor) throw Error('unreadable');
      return { rows: [], nextCursor: 'repeat' };
    }, { instance: {}, counts: { offline: { startFailed: 1 } } });
    assert.equal(snapshot.rows[0].sessionGroup, 'live'); assert.equal(snapshot.listKnown, false);
    assert.deepEqual(snapshot.attention.problems.map(item => item.source), ['offline_start_failed', 'groups']);
  }
});

test('resource tooltips distinguish host and container CPU and memory independently', () => {
  const document = createDocument(), system = { sampledAt: 100, cpu_pct: 25, cpu_count: 4, cpu_source: 'host', mem_pct: 50, mem_used_bytes: 1073741824, mem_total_bytes: 2147483648, mem_source: 'container', disk_pct: 10, disk_free_bytes: 1073741824 };
  const items = systemItems(document, system, { readAt: 100 });
  assert.match(items[0].title, /resourceSource.host/); assert.match(items[1].title, /resourceSource.container/);
  assert.match(items[0].textContent, /25%/); assert.match(items[1].textContent, /50%/);
  assert.equal(items[2].title.includes('resourceSource'), false);
});

test('compact current action preserves tool priority, received-message fallback and text safety', () => {
  const document = createDocument(), t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
  const minimal = compactRunning('current');
  const render = currentAction => renderRow({ ...minimal, sessionGroup: minimal.id, currentAction }, { document, t });
  const working = render({ tool: 'Bash', message: '<script>latest received', receivedAt: '2026-11-15T01:00:00Z' });
  assert.match(working.children[2].textContent, /wb.tool.Bash.*wb.board.lastIn.*latest received/);
  assert.equal(working.children[2].title, 'Bash');
  const technical = renderRow({ ...minimal, sessionGroup: minimal.id, currentAction: { tool: 'Bash', message: 'latest received', receivedAt: null } }, { document, t, level: 'technical' });
  assert.equal(technical.children[2].textContent, 'Bash', 'technical action never receives raw tool arguments');
  const message = render({ tool: null, message: '<img>received', receivedAt: '2026-11-15T01:00:00Z' });
  assert.match(message.children[2].textContent, /wb.board.lastReceived.*<img>received/);
  const timed = render({ tool: null, message: null, receivedAt: '2026-11-15T01:00:00Z' });
  assert.match(timed.children[2].textContent, /wb.board.lastReceivedAt.*time/);
  assert.equal(render({ tool: null, message: null, receivedAt: null }).children[2].textContent, '');
  assert.equal(working.children[2].children.some(node => node.tagName === 'SCRIPT'), false);
  assert.equal(message.children[2].children.some(node => node.tagName === 'IMG'), false);
});

test('no-response flag coexists with primary working state and exposes its authoritative start', () => {
  const document = createDocument(), since = '2026-11-15T01:00:00Z';
  const pill = statePill(document, compactRunning('waiting', { noResponse: { since } }));
  assert.match(pill.textContent, /wb.state.working.*wb.flags.noResponse/);
  const mark = pill.children[1].children[0];
  assert.equal(mark.title, formatZoned(since));
});

test('single and uncertain mode strips use catalog running counts and preserve unreadable uncertainty', () => {
  for (const mode of ['single', null]) for (const listKnown of [true, false]) {
    const document = createDocument(), root = document.createElement('div');
    instanceStrip(root, { mode, groupCounts: { listKnown, running: { total: 3 }, offline: { waitingSlot: 2 } }, instance: { pool: { used: 99, capacity: 100 } } }, { document });
    const pool = root.children.find(node => node.classList.contains('wb-pool'));
    assert.match(pool.textContent, listKnown ? /3/ : /—/);
    assert.equal(pool.textContent.includes('99'), false, 'resident running counts do not borrow multi-session occupancy');
  }
});
