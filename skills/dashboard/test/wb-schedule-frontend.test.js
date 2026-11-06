import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryLine, groupTasks, mountSchedule, targetLabel, writeMessage } from '../public/js/wb/schedule.js';
import { createForm, createPreviewer, formPayload, initialForm, saveAllowed } from '../public/js/wb/schedule-form.js';
import { allNodes, createDocument, deferred, tick } from './fixtures/workbench-dom.js';
import { packTranslator } from './fixtures/schedule-env.js';

const t = packTranslator();
const textOf = node => allNodes(node).map(item => item.text ?? '').join('|');
const buttons = (root, label) => allNodes(root).filter(node => node.tagName === 'BUTTON' && node.textContent === label);

function task(fields = {}) {
  return { id: 'task-1', name: 'Morning report', prompt: 'Write the report. Then send it.', type: 'recurring', status: 'pending',
    cron: '0 8 * * *', intervalSeconds: null, nextRunAt: 1800003600, lastRunAt: null, updatedAt: 1799990000, priority: 3,
    requireIdle: false, missThreshold: 300, showLastError: false, lastError: null, recent: [],
    nextRuns: { runs: [1800003600], in24h: [1800003600] }, target: { kind: 'origin' }, reply: null, reenable: false, ...fields };
}
const page = (tasks = [task()]) => ({ available: true, tz: 'Asia/Singapore', readAt: 0,
  kpi: { enabled: 1, paused: 0, running: 0, next24h: 1, partialPreview: false, runs7d: 0, bad7d: 0, successRate7d: null },
  daily7d: { tz: 'Asia/Singapore', utcFallback: false, days: [] }, tasks });

test('target and delivery lines use the dispatch target and always keep two parts', () => {
  const group = { kind: 'group', sessionGroup: 'telegram:dm-1001', componentName: 'telegram', displayName: null };
  const reply = { channel: 'telegram', endpoint: '1001' };
  assert.equal(targetLabel(group, { t }), 'Telegram · dm-1001');
  assert.equal(targetLabel(group, { t, level: 'technical' }), 'telegram:dm-1001');
  assert.equal(targetLabel({ ...group, displayName: '客户群' }, { t }), '客户群');
  assert.equal(targetLabel({ kind: 'raw', text: 'telegram:dm-1001' }, { t }), 'telegram:dm-1001');
  assert.equal(targetLabel({ kind: 'group', sessionGroup: 'telegram', componentName: 'telegram' }, { t }), 'Telegram');
  assert.equal(targetLabel({ kind: 'origin' }, { t }), '系统助手');
  assert.equal(targetLabel({ kind: 'origin' }, { t, level: 'technical' }), 'Origin');
  assert.equal(deliveryLine({ target: group, reply }, { t }), '在 Telegram · dm-1001 执行 · 结果发到 Telegram');
  assert.equal(deliveryLine({ target: group, reply }, { t, level: 'technical' }), '在 telegram:dm-1001 执行 · 结果发到 Telegram · 1001');
  assert.equal(deliveryLine({ target: { kind: 'origin' }, reply: null }, { t }), '在系统助手执行 · 结果不另外发送');
  const en = packTranslator('en');
  assert.equal(deliveryLine({ target: group, reply }, { t: en, locale: 'en' }), 'Runs in Telegram · dm-1001 · results go to Telegram');
});

test('list sections order enabled tasks by next run and keep expired and completed apart', () => {
  const tasks = [
    task({ id: 'late', nextRuns: { runs: [300], in24h: [] } }), task({ id: 'soon', nextRuns: { runs: [100], in24h: [] } }),
    task({ id: 'expired', status: 'failed', type: 'one-time' }), task({ id: 'done', status: 'completed', type: 'one-time' }),
    task({ id: 'off', status: 'paused' }), task({ id: 'busy', status: 'running', nextRuns: { runs: [200], in24h: [] } }),
  ];
  assert.deepEqual(groupTasks(tasks, { t }).map(section => [section.name, section.tasks.map(item => item.id)]), [
    ['enabled', ['soon', 'busy', 'late']], ['failed', ['expired']], ['paused', ['off']], ['completed', ['done']],
  ]);
  assert.deepEqual(groupTasks(tasks, { t, status: 'failed' }).map(section => section.name), ['failed']);
  assert.deepEqual(groupTasks(tasks, { t, query: 'BUSY' })[0].tasks.map(item => item.id), ['busy']);
  assert.equal(writeMessage({ result: 'unknown', reason: 'scheduler_cli_failed' }, t), '结果未知，已重新读取当前状态');
  assert.equal(writeMessage({ result: 'rejected', code: 'INVALID_ARGS', message: 'Priority must be 1-3' }, t), 'Priority must be 1-3');
});

test('the shared form has no delivery fields and saving follows the preview', () => {
  const document = createDocument();
  const form = createForm(document, { state: initialForm(), t, creating: true });
  const labels = form.root.children.filter(node => node.tagName === 'LABEL').map(node => node.children[0].textContent);
  assert.deepEqual(labels, ['名称', '内容', '时间方式', '时间', '优先级', '错过多久后跳过（秒）', '等空闲再跑']);
  assert.equal(labels.some(label => /目标|回复|组/.test(label)), false);
  assert.equal(form.save.disabled, true);
  const [name, prompt] = allNodes(form.root).filter(node => ['INPUT', 'TEXTAREA'].includes(node.tagName));
  prompt.value = 'Check backups';
  prompt.dispatch('input');
  const time = form.root.children[4].children[1];
  time.value = '*/x * * * *';
  time.dispatch('input');
  assert.equal(form.save.disabled, false);
  form.setPreview({ valid: false, error: 'invalid_cron' });
  assert.equal(form.save.disabled, true);
  assert.match(textOf(form.root), /规则写错了/);
  form.setPreview({ valid: null, error: 'cron_preview_unavailable' });
  assert.equal(form.save.disabled, false);
  assert.match(textOf(form.root), /无法预览，保存时由调度器校验/);
  let saved;
  const submitting = createForm(document, { state: { ...initialForm(), prompt: 'x', value: '1h', kind: 'every' }, t, creating: true,
    onSave: state => { saved = state; } });
  submitting.root.dispatch('submit', { preventDefault() {} });
  assert.deepEqual(formPayload(saved), { name: '', prompt: 'x', priority: '3', missThreshold: '300', requireIdle: false,
    schedule: { kind: 'every', value: '1h' } });
  assert.equal(name.tagName, 'INPUT');

  const expired = task({ type: 'one-time', status: 'failed', reenable: true, cron: null });
  const reenable = createForm(document, { state: initialForm(expired, { reenable: true }), t, reenable: true });
  assert.equal(reenable.save.disabled, true);
  assert.equal(reenable.root.children[3].children[1].disabled, true);
  assert.equal(saveAllowed({ ...initialForm(expired, { reenable: true }), value: '2030-01-01T09:00' },
    { valid: false, error: 'reschedule_not_future' }, { reenable: true }), false);
  const original = initialForm(task(), { tz: 'Asia/Singapore' });
  assert.equal('schedule' in formPayload({ ...original, name: 'New name' }, original), false);
  assert.deepEqual(formPayload({ ...original, value: '0 9 * * *' }, original).schedule, { kind: 'cron', value: '0 9 * * *' });
  assert.deepEqual(formPayload(initialForm(expired, { reenable: true }), initialForm(expired, { reenable: true }),
    { reenable: true }).schedule, { kind: 'at', value: '' });
});

test('preview requests are debounced and stale or failed previews do not block saving', async () => {
  const timers = [];
  const results = [];
  const pending = [deferred(), deferred()];
  let call = 0;
  const previewer = createPreviewer({ fetchPreview: () => pending[call++].promise, onResult: value => results.push(value),
    setTimer: handler => { timers.push(handler); return timers.length; }, clearTimer: () => {} });
  previewer.request('/a');
  previewer.request('/b');
  const first = timers[0]();
  const second = timers[1]();
  pending[1].reject(Error('offline'));
  pending[0].resolve({ valid: true });
  await first;
  await second;
  assert.deepEqual(results, [{ valid: null, error: 'preview_unavailable' }]);
  assert.equal(saveAllowed({ name: '', prompt: 'x', value: '0 8 * * *' }, results[0], { creating: true }), true);
});

function harness(context, respond, { writable = true, hidden = false } = {}) {
  const document = createDocument();
  const nodes = new Map(['#wb-schedule', '#tab-schedule', '#agent-detail', '#wb-detail-toggle']
    .map(selector => [selector, document.createElement('div')]));
  nodes.get('#tab-schedule').className = 'tab-panel active';
  document.querySelector = selector => nodes.get(selector);
  const listeners = new Map();
  document.addEventListener = (name, handler) => listeners.set(name, handler);
  document.removeEventListener = name => listeners.delete(name);
  document.visibilityState = hidden ? 'hidden' : 'visible';
  let mutation = null, owner = 'local';
  const window = { addEventListener() {}, removeEventListener() {},
    MutationObserver: class { constructor(handler) { mutation = handler; } observe() {} disconnect() { mutation = null; } } };
  const intervals = new Map();
  let next = 0;
  context.mock.method(globalThis, 'setInterval', (handler, delay) => { intervals.set(++next, { handler, delay }); return next; });
  context.mock.method(globalThis, 'clearInterval', id => intervals.delete(id));
  const calls = [], opened = [];
  const stop = mountSchedule({ document, window, t, writable: () => writable, identity: () => owner,
    endpoint: path => owner === 'local' ? path : `/fleet/${owner}${path}`, onOpenGroup: key => opened.push(key),
    now: () => 1800000000000,
    fetch: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      const value = await respond(path, options);
      return value?.json ? value : { ok: true, json: async () => value };
    } });
  context.after(stop);
  const root = nodes.get('#wb-schedule');
  return { document, nodes, root, calls, opened, stop, intervals, listeners,
    poll: () => [...intervals.values()].find(timer => timer.delay === 30000).handler(),
    setOwner: value => { owner = value; },
    mutate: () => mutation?.(),
    reads: () => calls.filter(call => call.method === 'GET' && call.path.endsWith('/api/workbench/schedule')).length };
}

// Mounted page lifecycle with the real schedule modules and injected DOM, fetch,
// timers and observers. Run for schedule page wiring, polling or write-flow
// changes; skip server-only edits. No sockets, DB, PM2, tmux or children; the
// isolated runner provides HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR and a private
// tmux directory. Teardown unmounts and restores the timer globals.
test('schedule page polls only while visible and keeps old rows after a read failure', async context => {
  let fail = false;
  const h = harness(context, path => {
    if (fail) throw Error('offline');
    return path.endsWith('/history?limit=30') ? { rows: [], next: null } : page();
  }, { hidden: true });
  await tick();
  assert.equal(h.reads(), 0);
  await h.poll();
  assert.equal(h.reads(), 0);
  h.document.visibilityState = 'visible';
  await h.poll();
  assert.equal(h.reads(), 1);
  assert.match(textOf(h.root), /Morning report/);
  assert.match(textOf(h.root), /时区 Asia\/Singapore（取自 .env）/);
  h.nodes.get('#tab-schedule').className = 'tab-panel';
  await h.poll();
  assert.equal(h.reads(), 1);
  h.nodes.get('#tab-schedule').className = 'tab-panel active';
  fail = true;
  await h.poll();
  assert.equal(h.reads(), 2);
  assert.match(textOf(h.root), /Morning report/);
  assert.match(textOf(h.root), /数据读取失败/);
  fail = false;
  await h.poll();
  assert.equal(textOf(h.root).includes('数据读取失败'), false);
  assert.match(textOf(h.root), /Morning report/);
  h.stop();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('schedule page discards a response that finishes after switching agents', async context => {
  const json = deferred();
  let first = true;
  const h = harness(context, path => {
    if (first && path === '/api/workbench/schedule') {
      first = false;
      return { ok: true, json: () => json.promise };
    }
    return page([task({ name: 'Other agent task' })]);
  });
  await tick();
  h.setOwner('Remote');
  json.resolve(page([task({ name: 'Previous agent task' })]));
  await tick();
  await tick();
  assert.equal(textOf(h.root).includes('Previous agent task'), false);
  await h.poll();
  await tick();
  assert.match(textOf(h.root), /Other agent task/);
  assert.ok(h.calls.some(call => call.path === '/fleet/Remote/api/workbench/schedule'));
});

test('an unknown write result re-reads the list once and a re-enable moves the task to enabled', async context => {
  let current = page([task({ id: 'task-x', type: 'one-time', status: 'failed', cron: null, reenable: true,
    showLastError: true, lastError: 'Missed execution window', nextRuns: [] })]);
  let outcome = { result: 'unknown', reason: 'scheduler_cli_failed' };
  const h = harness(context, (path, options) => {
    if (path.startsWith('/api/workbench/schedule/preview')) return { valid: true, runs: [1800009000] };
    if (path.includes('/history')) return { rows: [], next: null };
    if (options.method === 'PUT') return outcome;
    return current;
  });
  await tick();
  assert.match(textOf(h.root), /已失效/);
  allNodes(h.root).find(node => node.classList.contains('wb-sched-row')).dispatch('click');
  await tick();
  assert.match(textOf(h.root), /上次出错：Missed execution window/);
  assert.match(textOf(h.root), /在系统助手执行 · 结果不另外发送/);
  buttons(h.root, '改时间并重新启用')[0].dispatch('click');
  const form = allNodes(h.root).find(node => node.tagName === 'FORM');
  const time = allNodes(form).find(node => node.type === 'datetime-local');
  time.value = '2027-01-16T09:30';
  time.dispatch('input');
  const before = h.reads();
  form.dispatch('submit', { preventDefault() {} });
  await tick();
  await tick();
  const puts = h.calls.filter(call => call.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(JSON.parse(puts[0].body).schedule, { kind: 'at', value: '2027-01-16T09:30' });
  assert.equal(h.reads(), before + 1);
  assert.match(textOf(form), /结果未知，已重新读取当前状态/);

  outcome = { result: 'done', data: { task: { id: 'task-x' }, reenabled: true } };
  current = page([task({ id: 'task-x', type: 'one-time', status: 'pending', cron: null })]);
  form.dispatch('submit', { preventDefault() {} });
  await tick();
  await tick();
  assert.equal(h.reads(), before + 2);
  assert.match(textOf(h.root), /已重新启用/);
  const section = allNodes(h.root).find(node => node.classList.contains('wb-sched-section'));
  assert.equal(section.children[0].textContent, '启用中');
});

test('read-only agents get no write entry points and target groups open the overview', async context => {
  const group = { kind: 'group', sessionGroup: 'telegram:dm-1001', componentName: 'telegram', displayName: null };
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null }
    : page([task({ target: group, reply: { channel: 'telegram', endpoint: '1001' } })]), { writable: false });
  await tick();
  assert.equal(buttons(h.root, '新建').length, 0);
  allNodes(h.root).find(node => node.classList.contains('wb-sched-row')).dispatch('click');
  await tick();
  for (const label of ['编辑', '删除', '暂停', '改时间并重新启用']) assert.equal(buttons(h.root, label).length, 0, label);
  assert.match(textOf(h.root), /在 Telegram · dm-1001 执行 · 结果发到 Telegram/);
  buttons(h.root, 'Telegram · dm-1001')[0].dispatch('click', { stopPropagation() {} });
  assert.deepEqual(h.opened, ['telegram:dm-1001']);
  assert.equal(h.calls.some(call => call.method !== 'GET'), false);
});
