import test from 'node:test';
import assert from 'node:assert/strict';
import { axisLabels, dayTime, deliveryLine, groupTasks, laneDots, laneTicks, missText, mountSchedule, targetLabel, untilText, writeMessage,
  writeOutcome, statusCounts } from '../public/js/wb/schedule.js';
import { createForm, createPreviewer, formPayload, initialForm, saveAllowed } from '../public/js/wb/schedule-form.js';
import { allNodes, createDocument, deferred, tick } from './fixtures/workbench-dom.js';
import { packTranslator } from './fixtures/schedule-env.js';

const t = packTranslator();
const textOf = node => allNodes(node).map(item => item.text ?? '').join('|');
const buttons = (root, label) => allNodes(root).filter(node => node.tagName === 'BUTTON' && node.textContent === label);

function task(fields = {}) {
  return { promptTruncated: false, id: 'task-1', name: 'Morning report', prompt: 'Write the report. Then send it.', type: 'recurring', status: 'pending',
    cron: '0 8 * * *', intervalSeconds: null, nextRunAt: 1800003600, lastRunAt: null, updatedAt: 1799990000, priority: 3,
    requireIdle: false, missThreshold: 300, showLastError: false, lastError: null, recent: [],
    nextRuns: { runs: [1800003600], in24h: [1800003600] }, target: { kind: 'origin' }, reply: null, reenable: false, ...fields };
}
const page = (tasks = [task()]) => ({ available: true, tz: 'Asia/Singapore', readAt: 0,
  kpi: { enabled: 1, paused: 0, running: 0, next24h: 1, partialPreview: false, runs7d: 0, bad7d: 0, successRate7d: null },
  daily7d: { tz: 'Asia/Singapore', utcFallback: false, days: [] }, tasks, counts: statusCounts(tasks),
  timelineTasks: tasks.filter(item => ['pending', 'running'].includes(item.status)), nextCursor: null });

test('target and delivery lines use the dispatch target and always keep two parts', () => {
  const group = { kind: 'group', sessionGroup: 'telegram:dm-1001', componentName: 'telegram', displayName: null };
  const reply = { channel: 'telegram', endpoint: '1001' };
  assert.equal(targetLabel(group, { t }), 'Telegram · dm-1001');
  assert.equal(targetLabel(group, { t, level: 'technical' }), 'telegram:dm-1001');
  assert.equal(targetLabel({ ...group, displayName: '客户群' }, { t }), '客户群');
  assert.equal(targetLabel({ kind: 'raw', text: 'telegram:dm-1001' }, { t }), 'telegram:dm-1001');
  assert.equal(targetLabel({ kind: 'group', sessionGroup: 'telegram', componentName: 'telegram' }, { t }), 'Telegram');
  assert.equal(targetLabel({ kind: 'origin' }, { t }), 'Origin');
  assert.equal(targetLabel({ kind: 'origin' }, { t, level: 'technical' }), 'Origin');
  assert.equal(deliveryLine({ target: group, reply }, { t }), '在 Telegram · dm-1001 执行 · 结果发到 Telegram');
  assert.equal(deliveryLine({ target: group, reply }, { t, level: 'technical' }), '在 telegram:dm-1001 执行 · 结果发到 Telegram · 1001');
  assert.equal(deliveryLine({ target: { kind: 'origin' }, reply: null }, { t }), '在 Origin 执行 · 结果不另外发送');
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
  // Definite refusals without a scheduler envelope are rejections, not unknown results.
  for (const [status, error, text] of [[413, 'payload_too_large', '内容太长，未保存'], [400, 'invalid_json', '请求格式错误，未保存'],
    [403, 'insufficient_scope', '当前密钥只读，不能修改定时任务'], [403, 'read_only_proxy', '经代理访问这台 agent 时不允许这项修改'],
    [401, 'unauthorized', '登录已失效，请重新登录']]) {
    const outcome = writeOutcome(status, { error });
    assert.deepEqual(outcome, { result: 'rejected', code: error, message: '' });
    assert.equal(writeMessage(outcome, t), text);
  }
  for (const [status, value] of [[500, { error: 'internal_error' }], [502, { result: 'unknown', reason: 'scheduler_cli_failed' }], [200, null]]) {
    assert.equal(writeOutcome(status, value).result, 'unknown');
  }
  assert.equal(writeMessage({ result: 'rejected', code: 'invalid_form', message: 'missThreshold must be a whole number' }, t),
    '表单内容不合规');
  assert.equal(writeMessage({ result: 'rejected', code: 'prompt_starts_with_dashes', message: 'New task content cannot start with "--"' }, t),
    '新建任务的内容不能以 -- 开头');
  assert.equal(writeMessage({ result: 'rejected', code: 'invalid_task', message: 'Invalid task id' }, t), 'Invalid task id');
});

test('the shared form has no delivery fields and saving follows the preview', () => {
  const document = createDocument();
  const form = createForm(document, { state: initialForm(), t, creating: true });
  const labelText = node => node.children[0].textContent;
  const fields = allNodes(form.root).filter(node => node.classList.contains('wb-sched-field'));
  assert.deepEqual(fields.map(labelText), ['名称', '内容', '时间', '优先级', '错过多久跳过']);
  assert.deepEqual(allNodes(form.root).filter(node => node.dataset.kind).map(node => node.textContent), ['周期', '间隔', '一次性']);
  assert.match(textOf(form.root), /等空闲再跑/);
  assert.equal(fields.some(node => /目标|回复|组/.test(labelText(node))), false);
  assert.equal(form.title.textContent, '新建定时任务');
  assert.equal(form.save.disabled, true);
  const [name, prompt] = allNodes(form.root).filter(node => ['INPUT', 'TEXTAREA'].includes(node.tagName));
  prompt.value = 'Check backups';
  prompt.dispatch('input');
  const time = fields[2].children[2];
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
  assert.equal(allNodes(reenable.root).filter(node => node.dataset.kind).every(node => node.disabled), true);
  for (const missThreshold of ['1.5', '1e3', '', '-1']) {
    assert.equal(saveAllowed({ ...initialForm(), prompt: 'x', value: '1h', missThreshold }, null, { creating: true }), false, missThreshold);
  }
  assert.equal(saveAllowed({ ...initialForm(), prompt: 'x', value: '1h', missThreshold: '600' }, null, { creating: true }), true);
  const thresholdForm = createForm(document, { state: { ...initialForm(), prompt: 'x', kind: 'every', value: '1h' }, t, creating: true });
  assert.equal(thresholdForm.save.disabled, false);
  // The miss threshold is a choice list; a stored value outside the usual choices stays selectable.
  const threshold = allNodes(thresholdForm.root).filter(node => node.tagName === 'SELECT')[1];
  assert.deepEqual(threshold.children.map(node => node.value), ['300', '1800', '3600', '86400']);
  threshold.value = '1800';
  threshold.dispatch('change');
  assert.equal(thresholdForm.state().missThreshold, '1800');
  assert.equal(thresholdForm.save.disabled, false);
  const custom = createForm(document, { state: { ...initialForm(), missThreshold: '120' }, t, creating: true });
  assert.equal(allNodes(custom.root).filter(node => node.tagName === 'SELECT')[1].children.at(-1).textContent, '2 分钟');
  const hours = createForm(document, { state: { ...initialForm(), missThreshold: '7200' }, t, creating: true });
  assert.equal(allNodes(hours.root).filter(node => node.tagName === 'SELECT')[1].children.at(-1).textContent, '2 小时');
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
  assert.equal(saveAllowed({ name: '', prompt: 'x', value: '0 8 * * *', missThreshold: '300' }, results[0], { creating: true }), true);
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
      let value = await respond(path, options);
      // Existing page fixtures share their full task rows with the detail route.
      const detail = path.match(/\/api\/workbench\/schedule\/([^/?]+)$/);
      if (detail && value?.tasks) value = { task: value.tasks.find(item => item.id === decodeURIComponent(detail[1])) };
      if (!detail && value?.tasks) value = { ...value, tasks: value.tasks.map(task => {
        if (!Object.hasOwn(task, 'promptTruncated')) return task;
        const summary = { ...task, promptSummary: task.promptSummary ?? task.prompt };
        delete summary.prompt;
        return summary;
      }) };
      return value?.json ? value : { ok: true, json: async () => value };
    } });
  context.after(stop);
  const root = nodes.get('#wb-schedule');
  return { document, nodes, root, calls, opened, stop, intervals, listeners,
    poll: () => [...intervals.values()].find(timer => timer.delay === 30000).handler(),
    setOwner: value => { owner = value; },
    mutate: () => mutation?.(),
    reads: () => calls.filter(call => call.method === 'GET' && call.path.split('?')[0].endsWith('/api/workbench/schedule')).length };
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
  assert.equal(textOf(h.root).includes('时区未知'), false);
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
  allNodes(h.root).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  assert.match(textOf(h.root), /上次送达失败：Missed execution window/);
  assert.match(textOf(h.root), /在 Origin 执行 · 结果不另外发送/);
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
  assert.match(section.children[0].textContent, /^启用中/);
});

test('read-only agents get no write entry points and target groups open the overview', async context => {
  const group = { kind: 'group', sessionGroup: 'telegram:dm-1001', componentName: 'telegram', displayName: null };
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null }
    : page([task({ target: group, reply: { channel: 'telegram', endpoint: '1001' } })]), { writable: false });
  await tick();
  assert.equal(buttons(h.root, '新建任务').length, 0);
  allNodes(h.root).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  for (const label of ['编辑', '删除', '暂停', '改时间并重新启用']) assert.equal(buttons(h.root, label).length, 0, label);
  assert.match(textOf(h.root), /在 Telegram · dm-1001 执行 · 结果发到 Telegram/);
  buttons(h.root, 'Telegram · dm-1001')[0].dispatch('click');
  assert.deepEqual(h.opened, ['telegram:dm-1001']);
  assert.equal(h.calls.some(call => call.method !== 'GET'), false);
});

test('target buttons pass the exact group key to the supplied opener from list and detail', async context => {
  const groups = [
    { kind: 'group', sessionGroup: 'openmax:research', componentName: 'openmax', displayName: 'Research' },
    { kind: 'group', sessionGroup: 'telegram:older-group', componentName: 'telegram', displayName: null },
  ];
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null }
    : page(groups.map((target, index) => task({ id: `task-${index}`, target }))));
  await tick();
  const targets = () => allNodes(h.root).filter(node => node.tagName === 'BUTTON' && node.classList.contains('wb-sched-target'));
  targets()[0].dispatch('click');
  targets()[1].dispatch('click');
  assert.deepEqual(h.opened, groups.map(group => group.sessionGroup));
  assert.equal(targets()[1].textContent, 'Telegram · older-group');
  allNodes(h.root).filter(node => node.classList.contains('wb-sched-select'))[1].dispatch('click');
  await tick();
  targets().at(-1).dispatch('click');
  assert.deepEqual(h.opened, [...groups.map(group => group.sessionGroup), 'telegram:older-group']);
});

test('schedule page shows an unknown time zone, unavailable previews and the idle setting', async context => {
  const broken = task({ id: 'task-cron', name: 'Broken rule', cron: 'bad', requireIdle: true,
    nextRuns: { unavailable: true, reason: 'cron_preview_unavailable' } });
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null }
    : { ...page([broken]), tz: null, tzReason: 'tz_unavailable', daily7d: { tz: 'UTC', utcFallback: true, days: [] } });
  await tick();
  assert.match(textOf(h.root), /时区未知 · 时间按 UTC 显示/);
  const select = allNodes(h.root).find(node => node.classList.contains('wb-sched-select'));
  assert.equal(select.children.find(node => node.classList.contains('wb-sched-next')).textContent, '无法预览');
  assert.equal(allNodes(h.root).some(node => node.classList.contains('wb-sched-dot')), false);
  select.dispatch('click');
  await tick();
  assert.match(textOf(h.root), /接下来 5 次\|无法预览/);
  assert.match(textOf(h.root), /等空闲再跑：是/);
});

test('a refused write explains the refusal and rows hold two sibling buttons', async context => {
  const group = { kind: 'group', sessionGroup: 'telegram:dm-1001', componentName: 'telegram', displayName: null };
  const h = harness(context, (path, options) => {
    if (options.method === 'PUT') return { ok: false, status: 413, json: async () => ({ error: 'payload_too_large' }) };
    return path.includes('/history') ? { rows: [], next: null } : page([task({ target: group })]);
  });
  await tick();
  const row = allNodes(h.root).find(node => node.classList.contains('wb-sched-row'));
  assert.equal(row.tagName, 'DIV');
  assert.equal(row.listeners.size, 0);
  assert.deepEqual(row.children.map(node => [node.tagName, node.className]),
    [['BUTTON', 'wb-sched-select'], ['BUTTON', 'wb-sched-target'], ['SPAN', 'wb-sched-state wb-on']]);
  assert.equal(allNodes(row.children[0]).filter(node => node.tagName === 'BUTTON').length, 1);
  // Activating the group button opens the group and does not select the task.
  row.children[1].dispatch('click');
  await tick();
  assert.deepEqual(h.opened, ['telegram:dm-1001']);
  assert.equal(textOf(h.root).includes('等空闲再跑'), false);
  row.children[0].dispatch('click');
  await tick();
  assert.match(textOf(h.root), /等空闲再跑：否/);
  buttons(h.root, '编辑')[0].dispatch('click');
  const form = allNodes(h.root).find(node => node.tagName === 'FORM');
  const before = h.reads();
  form.dispatch('submit', { preventDefault() {} });
  await tick();
  await tick();
  assert.equal(h.reads(), before + 1);
  assert.match(textOf(form), /内容太长，未保存/);
  assert.equal(textOf(form).includes('结果未知'), false);
});


// Pure time helpers with a fixed clock in the scheduler's zone (Asia/Singapore, UTC+8).
const SGT = 'Asia/Singapore', at = (hours, minutes = 0) => Date.UTC(2027, 0, 15, hours - 8, minutes) / 1000;

test('countdowns, day words and miss thresholds read the way the list and drawer show them', () => {
  const now = at(16) * 1000;
  assert.equal(untilText(at(16, 25), now, t), '25m后');
  assert.equal(untilText(at(20, 39), now, t), '4h39m后');
  assert.equal(untilText(at(16) + 2 * 86400 + 3 * 3600, now, t), '2d3h后');
  assert.equal(untilText(at(15, 30), now, t), '30m前');
  assert.equal(untilText(null, now, t), '');
  assert.equal(dayTime(at(23, 45), { tz: SGT, nowMs: now, t }), '今天 23:45');
  assert.equal(dayTime(at(24), { tz: SGT, nowMs: now, t }), '明天 00:00');
  assert.equal(dayTime(at(8) - 86400, { tz: SGT, nowMs: now, t }), '昨天 08:00');
  assert.equal(dayTime(at(8) + 3 * 86400, { tz: SGT, nowMs: now, t }), '01-18 08:00');
  assert.equal(dayTime(null, { tz: SGT, nowMs: now, t }), '—');
  assert.deepEqual(['300', 1800, 3600, 86400, 7200, 45, -1, 'x'].map(value => missText(value, t)),
    ['5 分钟', '30 分钟', '1 小时', '1 天', '2 小时', '45 秒', '—', '—']);
});

test('the next-24-hours lane ticks every three clock hours and spreads close dots over rows', () => {
  const start = at(16);
  const ticks = laneTicks(start, SGT);
  assert.deepEqual(ticks.map(tick => tick.hour), ['18', '21', '00', '03', '06', '09', '12', '15']);
  assert.equal(ticks[0].left, 2 * 3600 / 864);
  assert.equal(ticks.find(tick => tick.midnight).hour, '00');
  const dots = laneDots([task({ id: 'a', nextRuns: { in24h: [start + 3600, start + 3700] } }),
    task({ id: 'b', nextRuns: { in24h: [start + 3650, start + 40000] } })], start);
  assert.deepEqual(dots.map(dot => [dot.task.id, dot.row]), [['a', 0], ['b', 1], ['a', 2], ['b', 0]]);
  assert.ok(dots.every(dot => dot.left >= 0 && dot.left <= 100));
});

test('lane labels stay inside the lane and keep "tomorrow 00:00" at 00:10 and 23:00', () => {
  // 00:10: midnight is the last tick, 99.3% across; it is right-aligned so it cannot spill past the lane.
  const early = axisLabels(laneTicks(at(24, 10), SGT));
  const lastMidnight = early.labels.find(label => label.midnight);
  assert.ok(lastMidnight.left > 99);
  assert.deepEqual(lastMidnight.classes, ['wb-end']);
  assert.equal(early.hideNow, false);
  // 23:00: midnight is 4% in, next to "now". It stays (left-aligned) and "now" gives way.
  const late = axisLabels(laneTicks(at(23), SGT));
  const firstMidnight = late.labels.find(label => label.midnight);
  assert.ok(firstMidnight.left < 6);
  assert.deepEqual(firstMidnight.classes, ['wb-start']);
  assert.equal(late.hideNow, true);
  // Midnight is never thinned out on a narrow lane; other labels near "now" or at odd positions are.
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    const { labels } = axisLabels(laneTicks(at(0, minute), SGT));
    const midnight = labels.find(label => label.midnight);
    // At exactly 00:00 the next midnight is 24 hours away, just past the lane.
    if (minute) assert.deepEqual(midnight.classes.filter(name => !['wb-start', 'wb-end'].includes(name)), [], String(minute));
    for (const label of labels) {
      if (label.left > 94) assert.ok(label.classes.includes('wb-end'), String(minute));
      if (label.left < 6) assert.ok(label.classes.includes('wb-start'), String(minute));
    }
  }
});

test('a refresh keeps the drawer scroll position and an open form keeps its node, focus and text', async context => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: index, executedAt: 1799990000 - index * 3600, status: 'success', duration: 1000 }));
  const h = harness(context, path => path.includes('/history') ? { rows, next: null } : page());
  await tick();
  allNodes(h.root).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  const aside = h.root.children.find(node => node.tagName === 'ASIDE');
  const body = () => allNodes(aside).find(node => node.classList.contains('wb-detail-body'));
  body().scrollTop = 375;
  await h.poll();
  assert.equal(h.root.children.find(node => node.tagName === 'ASIDE'), aside, 'the drawer stays mounted');
  assert.equal(body().scrollTop, 375);
  buttons(h.root, '加载全部')[0].dispatch('click');
  assert.equal(body().scrollTop, 375);
  buttons(h.root, '编辑')[0].dispatch('click');
  const panel = aside.children[0];
  const name = allNodes(panel).find(node => node.tagName === 'INPUT');
  name.focus();
  name.value = 'Renamed';
  name.dispatch('input');
  await h.poll();
  assert.equal(aside.children[0], panel, 'the form is not rebuilt');
  assert.equal(allNodes(aside).find(node => node.tagName === 'INPUT'), name);
  assert.equal(name.focused, true);
  assert.equal(name.value, 'Renamed');
});

test('Esc leaves an input method alone and keeps a form with typed changes open', async context => {
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null } : page());
  await tick();
  const escape = (fields = {}) => h.listeners.get('keydown')({ key: 'Escape', preventDefault() {}, ...fields });
  const formOpen = () => allNodes(h.root).some(node => node.tagName === 'FORM');
  buttons(h.root, '新建任务')[0].dispatch('click');
  escape();
  assert.equal(formOpen(), false, 'an untouched form closes');
  buttons(h.root, '新建任务')[0].dispatch('click');
  escape({ isComposing: true });
  escape({ keyCode: 229 });
  assert.equal(formOpen(), true, 'composing text keeps the form');
  const prompt = allNodes(h.root).find(node => node.tagName === 'TEXTAREA');
  prompt.value = '整理今天的日志';
  prompt.dispatch('input');
  escape();
  assert.equal(formOpen(), true, 'typed changes keep the form');
  assert.equal(prompt.value, '整理今天的日志');
  buttons(h.root, '取消')[0].dispatch('click');
  assert.equal(formOpen(), false);
});

test('the edit button of an expired one-time task opens the re-enable form', async context => {
  const expired = task({ id: 'task-x', type: 'one-time', status: 'failed', cron: null, reenable: true,
    showLastError: true, lastError: 'Missed execution window', nextRuns: [] });
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null }
    : path.startsWith('/api/workbench/schedule/preview') ? { valid: true, runs: [] } : page([expired]));
  await tick();
  allNodes(h.root).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  assert.equal(buttons(h.root, '改时间并重新启用').length, 1);
  buttons(h.root, '编辑')[0].dispatch('click');
  const form = allNodes(h.root).find(node => node.tagName === 'FORM');
  assert.ok(form);
  assert.ok(allNodes(h.root).some(node => node.classList.contains('wb-d-title') && node.textContent === '改时间并重新启用'));
  assert.equal(allNodes(form).filter(node => node.dataset.kind).every(node => node.disabled), true);
  assert.equal(allNodes(form).find(node => node.type === 'datetime-local').value, '');
});

test('task detail header gives the title its own row and keeps state and actions together for the second row', async context => {
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null } : page());
  await tick();
  allNodes(h.root).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  const top = allNodes(h.root).find(node => node.classList.contains('wb-d-top') && node.children.some(child => child.classList.contains('wb-d-sub')));
  assert.ok(top, 'the detail header has a state-and-actions group');
  assert.deepEqual(top.children.map(child => child.className.split(' ')[0]), ['wb-ch', 'wb-d-title', 'wb-d-sub', 'wb-icon-btn']);
  assert.ok(top.children.at(-1).classList.contains('wb-sched-close'), 'closing stays on the title row');
  const sub = top.children[2];
  assert.ok(sub.children[0].classList.contains('wb-sched-state'), 'the state comes first in the second row');
  assert.ok(sub.children[1].classList.contains('wb-d-acts'), 'the actions follow the state');
  assert.equal(allNodes(sub.children[1]).some(node => node.classList.contains('wb-icon-danger')), true, 'deleting is among those actions');
});

function chooseFilter(h, name) {
  allNodes(h.root).find(node => node.tagName === 'BUTTON' && node.attributes['aria-pressed'] !== undefined &&
    node.textContent.startsWith(t('wb.schedule.filter.' + name))).dispatch('click');
}
const listRows = h => allNodes(h.root).filter(node => node.classList.contains('wb-sched-select'));

// Mounted contract cases below use only the injected DOM/fetch/timers. Run for
// list pagination, server search, detail loading or lifecycle changes; skip for
// server-only edits. No external resources or children; the isolated Node runner
// owns HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and teardown unmounts each page.
test('completed pages keep server counts and timeline and follow fresh cursors on a poll', async context => {
  const active = task();
  const completed = Array.from({ length: 101 }, (_, index) => task({ id: `done-${index}`, name: `Completed ${index}`,
    type: 'one-time', status: 'completed', nextRuns: { runs: [], in24h: [] } }));
  const counts = { all: 120, enabled: 11, paused: 8, failed: 0, completed: 101 };
  let generation = 0;
  const h = harness(context, path => {
    const query = new URL(path, 'http://fixture.invalid').searchParams;
    if (query.get('status') !== 'completed') return { ...page([active]), counts };
    const cursor = query.get('cursor');
    if (!cursor) generation++;
    const start = cursor ? 30 : 0;
    return { ...page(completed.slice(start, start + 30)), counts, timelineTasks: [active], nextCursor: `page-${generation}` };
  });
  await tick();
  chooseFilter(h, 'completed');
  await tick();
  assert.equal(listRows(h).length, 30);
  assert.equal(allNodes(h.root).filter(node => node.classList.contains('wb-sched-dot')).length, 1);
  assert.ok(allNodes(h.root).some(node => node.textContent === '全部120'));
  assert.ok(allNodes(h.root).some(node => node.textContent === '已送达101'));
  buttons(h.root, '加载更多')[0].dispatch('click');
  await tick();
  assert.equal(listRows(h).length, 60);
  await h.poll();
  assert.equal(listRows(h).length, 60, 'poll retains the expanded page depth');
  assert.ok(h.calls.some(call => call.path.includes('cursor=page-2')), 'poll follows the newly issued cursor');
  assert.equal(allNodes(h.root).filter(node => node.classList.contains('wb-sched-dot')).length, 1);
  const search = allNodes(h.root).find(node => node.type === 'search');
  search.value = 'needle'; search.dispatch('change');
  await tick();
  assert.equal(listRows(h).length, 30, 'new search resets the completed cursor');
  assert.ok(h.calls.at(-1).path.includes('q=needle'));
  assert.equal(h.calls.at(-1).path.includes('cursor='), false);
});

test('a full-text server search keeps matches whose prompt summary does not contain the query', async context => {
  const match = task({ prompt: 'Only the summary is sent.', promptTruncated: true });
  const h = harness(context, path => {
    const query = new URL(path, 'http://fixture.invalid').searchParams;
    return page(query.get('q') === 'tail phrase' ? [match] : [task()]);
  });
  await tick();
  const search = allNodes(h.root).find(node => node.type === 'search');
  search.value = 'tail phrase'; search.dispatch('search');
  await tick();
  assert.ok(h.calls.some(call => call.path.includes('q=tail+phrase')));
  assert.equal(listRows(h).length, 1);
  assert.match(textOf(h.root), /Only the summary is sent/);
});

test('a late completed page cannot replace a newly selected filter', async context => {
  const more = deferred();
  const done = task({ id: 'done-1', name: 'Completed first', status: 'completed', nextRuns: { runs: [], in24h: [] } });
  const h = harness(context, path => {
    if (path.includes('cursor=')) return { ok: true, json: () => more.promise };
    if (path.includes('status=completed')) return { ...page([done]), nextCursor: 'next' };
    return page();
  });
  await tick(); chooseFilter(h, 'completed'); await tick();
  buttons(h.root, '加载更多')[0].dispatch('click');
  await tick();
  chooseFilter(h, 'all'); await tick();
  more.resolve(page([task({ id: 'late', name: 'Stale completed task', status: 'completed' })]));
  await tick();
  assert.match(textOf(h.root), /Morning report/);
  assert.equal(textOf(h.root).includes('Stale completed task'), false);
  assert.equal(textOf(h.root).includes('Completed first'), false);
});

test('detail and editing wait for the complete prompt instead of using a list summary', async context => {
  const detail = deferred();
  const summary = task({ prompt: 'Truncated summary', promptTruncated: true });
  const full = 'Complete prompt\n' + '内容'.repeat(240) + '\nfinal secret tail';
  const h = harness(context, path => {
    if (path === '/api/workbench/schedule/task-1') return { ok: true, json: () => detail.promise };
    if (path.includes('/history')) return { rows: [], next: null };
    return page([summary]);
  });
  await tick(); listRows(h)[0].dispatch('click'); await tick();
  assert.equal(buttons(h.root, '编辑').length, 0, 'no editable summary while detail is loading');
  assert.equal(allNodes(h.root).some(node => node.classList.contains('wb-sched-prompt')), false);
  detail.resolve({ task: task({ prompt: full, promptTruncated: false }) });
  await tick();
  assert.equal(allNodes(h.root).find(node => node.classList.contains('wb-sched-prompt')).textContent, full);
  buttons(h.root, '编辑')[0].dispatch('click');
  assert.equal(allNodes(h.root).find(node => node.tagName === 'TEXTAREA').value, full);
});

test('detail failures and stale detail replies expose no editable truncated prompt', async context => {
  const late = deferred();
  const h = harness(context, path => {
    if (path === '/api/workbench/schedule/task-1') return { ok: true, json: () => late.promise };
    if (path === '/api/workbench/schedule/other') throw Error('offline');
    if (path.includes('/history')) return { rows: [], next: null };
    return page([task({ promptTruncated: true }), task({ id: 'other', name: 'Other task', promptTruncated: true })]);
  });
  await tick(); listRows(h)[0].dispatch('click'); await tick();
  listRows(h)[1].dispatch('click'); await tick();
  late.resolve({ task: task({ name: 'Outdated detail', prompt: 'Full but outdated' }) });
  await tick();
  assert.equal(textOf(h.root).includes('Outdated detail'), false);
  assert.match(textOf(h.root), /数据读取失败/);
  assert.equal(buttons(h.root, '编辑').length, 0);
  assert.equal(allNodes(h.root).some(node => node.tagName === 'TEXTAREA'), false);
});

test('a global timeline dot opens its full task while the completed list is selected', async context => {
  const active = task({ prompt: 'Active full prompt from detail' });
  const done = task({ id: 'done', name: 'Completed item', status: 'completed', nextRuns: { runs: [], in24h: [] } });
  const h = harness(context, path => {
    if (path === '/api/workbench/schedule/task-1') return { task: active };
    if (path.includes('/history')) return { rows: [], next: null };
    return path.includes('status=completed') ? { ...page([done]), timelineTasks: [active] } : page([active]);
  });
  await tick(); chooseFilter(h, 'completed'); await tick();
  assert.equal(listRows(h).length, 1);
  assert.match(listRows(h)[0].textContent, /Completed item/);
  allNodes(h.root).find(node => node.classList.contains('wb-sched-dot')).dispatch('click');
  await tick();
  assert.equal(allNodes(h.root).find(node => node.classList.contains('wb-sched-prompt')).textContent, active.prompt);
  assert.equal(buttons(h.root, '编辑').length, 1);
});

test('legacy full task lists search locally and edit without a detail endpoint', async context => {
  const full = 'Legacy full prompt '.repeat(25) + 'uniquetail';
  const legacy = task({ id: 'legacy', status: 'completed', prompt: full, nextRuns: { runs: [], in24h: [] } });
  delete legacy.promptTruncated;
  const unmatched = task({ id: 'unmatched-legacy', name: 'Unrelated legacy task', prompt: 'Different content' });
  delete unmatched.promptTruncated;
  const h = harness(context, path => {
    if (path.includes('/history')) return { rows: [], next: null };
    assert.equal(path, '/api/workbench/schedule', 'legacy reads never request search or task detail');
    const value = page([legacy, unmatched]);
    delete value.counts;
    delete value.timelineTasks;
    return value;
  });
  await tick();
  assert.equal(listRows(h).length, 2, 'both legacy tasks are initially loaded');
  const before = h.reads();
  const search = allNodes(h.root).find(node => node.type === 'search');
  search.value = 'uniquetail'; search.dispatch('change');
  assert.equal(h.reads(), before, 'legacy fulltext search uses the already loaded prompt');
  assert.equal(listRows(h).length, 1, 'legacy all search retains completed matches');
  assert.equal(listRows(h).some(node => node.textContent.includes(unmatched.name)), false, 'unmatched legacy content is filtered out');
  listRows(h)[0].dispatch('click'); await tick();
  assert.equal(h.calls.some(call => call.path === '/api/workbench/schedule/legacy'), false);
  buttons(h.root, '编辑')[0].dispatch('click');
  assert.equal(allNodes(h.root).find(node => node.tagName === 'TEXTAREA').value, full);
});

test('dense task runs use one accessible band while sparse task dots and real counts remain', async context => {
  const start = 1800000000;
  const dense = task({ name: 'Every minute', nextRuns: { runs: [start + 60],
    in24h: Array.from({ length: 1440 }, (_, index) => start + (index + 1) * 60) } });
  const sparse = task({ id: 'daily', name: 'Daily summary', nextRuns: { runs: [start + 3600], in24h: [start + 3600] } });
  const h = harness(context, path => {
    if (path.includes('/history')) return { rows: [], next: null };
    const value = page([dense, sparse]);
    value.kpi.next24h = 1441;
    return value;
  });
  await tick();
  const bands = allNodes(h.root).filter(node => node.classList.contains('wb-sched-band'));
  const dots = allNodes(h.root).filter(node => node.classList.contains('wb-sched-dot'));
  assert.equal(bands.length, 1);
  assert.equal(bands[0].attributes['aria-label'], 'Every minute · 1440 次');
  assert.equal(dots.length, 1);
  assert.match(dots[0].title, /Daily summary/);
  assert.ok(Number.parseFloat(bands[0].style.top) > Number.parseFloat(dots[0].style.top));
  assert.match(textOf(h.root), /1441 次/);
  bands[0].dispatch('click'); await tick();
  assert.equal(allNodes(h.root).find(node => node.classList.contains('wb-d-title')).textContent, 'Every minute');
});

test('all search pages combine active and completed matches without repeating active rows', async context => {
  const active = task({ id: 'active-match', name: 'Active match' });
  const completed = Array.from({ length: 61 }, (_, index) => task({ id: `complete-${index}`, name: `Completed match ${index}`,
    status: 'completed', nextRuns: { runs: [], in24h: [] } }));
  const h = harness(context, path => {
    const query = new URL(path, 'http://fixture.invalid').searchParams;
    if (!query.has('q')) return page([active]);
    const start = query.has('cursor') ? 30 : 0;
    return { ...page([active, ...completed.slice(start, start + 30)]), timelineTasks: [active], nextCursor: 'next-completed' };
  });
  await tick();
  const search = allNodes(h.root).find(node => node.type === 'search');
  search.value = 'match'; search.dispatch('change'); await tick();
  assert.equal(listRows(h).length, 31);
  assert.match(listRows(h)[0].textContent, /Active match/);
  buttons(h.root, '加载更多')[0].dispatch('click'); await tick();
  assert.equal(listRows(h).length, 61);
  assert.equal(listRows(h).filter(node => node.textContent.includes('Active match')).length, 1);
  await h.poll();
  assert.equal(listRows(h).length, 61, 'combined search retains expanded page depth');
  const searches = h.calls.filter(call => call.path.includes('q=match'));
  assert.ok(searches.at(-1).path.includes('cursor='));
});


test('delivery rates exclude old timeouts while history preserves them without a last-error card', async context => {
  const rows = [
    { id: 3, status: 'timeout', executedAt: 1799999990, completedAt: 1800000000, duration: 10000, error: 'TASK_TIMEOUT' },
    { id: 2, status: 'success', executedAt: 1799999980, completedAt: 1799999981, duration: 1000, error: null },
    { id: 1, status: 'failed', executedAt: 1799999970, completedAt: 1799999971, duration: 1000, error: 'RECEIVE_FAILED' },
  ];
  const item = task({ recent: rows.slice().reverse(), showLastError: false, lastError: null });
  const value = { ...page([item]), kpi: { ...page().kpi, runs7d: 3, bad7d: 1, successRate7d: 0.5 },
    daily7d: { days: [{ date: '2027-01-15', success: 1, timeout: 1, failed: 1 }] } };
  const h = harness(context, path => path.includes('/history') ? { rows, next: null } : value);
  await tick();
  assert.match(textOf(h.root), /送达率/);
  assert.match(textOf(h.root), /其中送达失败/);
  const ring = allNodes(h.root).find(node => node.classList.contains('wb-sched-ring'));
  assert.equal(ring.style['--ok'], '50%');
  assert.equal(ring.style['--late'], '50%');
  allNodes(h.root).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  const numbers = allNodes(h.root).find(node => node.classList.contains('wb-detail-numbers'));
  assert.match(numbers.textContent, /50%/);
  assert.match(textOf(h.root), /TASK_TIMEOUT/);
  assert.match(textOf(h.root), /超时/);
  assert.equal(allNodes(h.root).filter(node => node.classList.contains('wb-sched-error-card')).length, 0);
});

test('legacy timeout can retain its re-enable action without claiming a delivery failure', async context => {
  const item = task({ id: 'legacy-timeout', type: 'one-time', status: 'failed', reenable: true,
    showLastError: false, lastError: null, recent: [] });
  const h = harness(context, path => path.includes('/history') ? { rows: [], next: null } : page([item]));
  await tick();
  allNodes(h.root).find(node => node.classList.contains('wb-sched-select')).dispatch('click');
  await tick();
  assert.doesNotMatch(textOf(h.root), /上次送达失败/);
  assert.ok(buttons(h.root, '改时间并重新启用').length);
});

test('weekly delivery failure note ignores a timeout-heavy day when selecting the day and count', async context => {
  const value = { ...page(), daily7d: { days: [
    { date: '2027-01-12', success: 2, timeout: 80, failed: 0 },
    { date: '2027-01-13', success: 1, timeout: 7, failed: 1 },
    { date: '2027-01-14', success: 4, timeout: 5, failed: 2 },
  ] } };
  const h = harness(context, () => value);
  await tick();
  const legend = allNodes(h.root).find(node => node.classList.contains('wb-sched-legend'));
  const note = allNodes(legend).find(node => node.classList.contains('wb-sched-note'));
  assert.equal(note.textContent, '最多送达失败：01-14（2 次）');
  const timeouts = allNodes(legend).find(node => node.classList.contains('wb-timeout'));
  assert.match(timeouts.textContent, /超时92/);
});

test('weekly delivery summary keeps legacy timeouts visible without a false worst-failure note', async context => {
  const value = { ...page(), daily7d: { days: [
    { date: '2027-01-12', success: 0, timeout: 60, failed: 0 },
    { date: '2027-01-13', success: 0, timeout: 4, failed: 0 },
  ] } };
  const h = harness(context, () => value);
  await tick();
  const legend = allNodes(h.root).find(node => node.classList.contains('wb-sched-legend'));
  assert.equal(allNodes(legend).filter(node => node.classList.contains('wb-sched-note')).length, 0);
  const timeouts = allNodes(legend).find(node => node.classList.contains('wb-timeout'));
  assert.match(timeouts.textContent, /超时64/);
});
