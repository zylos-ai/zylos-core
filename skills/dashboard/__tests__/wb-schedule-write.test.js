import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
// Imported under its own URL so the HTTP case below loads the server's copy with
// the child-process spy in place.
const { createSchedulerCli, createScheduleWrite, formToArgs } = await import('../src/lib/workbench/schedule-write.js?direct');
import { createScheduleRead } from '../src/lib/workbench/schedule-read.js';
import { initialForm, formPayload } from '../public/js/wb/schedule-form.js';
import { createScheduleTz } from '../src/lib/workbench/schedule-tz.js';
import { AuthGate, hashApiKey } from '../src/lib/auth.js';
import { deliveryLine, groupTasks, writeMessage } from '../public/js/wb/schedule.js';
import { scheduleEnv, packTranslator } from './fixtures/schedule-env.js';

const TZ_URL = new URL('../../scheduler/scripts/tz.js', import.meta.url).href;
const REPLY_FLAGS = /^--(?:reply-|clear-reply|clear-session-group)/;
const t = packTranslator();
let importCase = 0;

function useZylosDir(context, dir) {
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  context.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
  });
}

/** The Dashboard side of one isolated installation: real CLI child, real read model. */
function dashboard(context, options = {}) {
  const f = scheduleEnv(context, options);
  useZylosDir(context, f.zylosDir);
  const scheduleTz = createScheduleTz({ zylosDir: f.zylosDir, tzModule: `${TZ_URL}?case=${++importCase}` });
  const env = { ...f.env, ...options.processEnv };
  const writer = createScheduleWrite({ zylosDir: f.zylosDir, scheduleTz,
    schedulerCli: createSchedulerCli({ zylosDir: f.zylosDir, env }) });
  const snapshotRows = options.snapshotRows ?? [];
  const reader = createScheduleRead({ zylosDir: f.zylosDir, scheduleTz, getSnapshot: async () => ({ rows: snapshotRows }) });
  const write = (method, route, body) => writer.write(method, route, async () => body);
  const task = async id => (await reader.read()).tasks.find(item => item.id === id);
  return { ...f, writer, reader, write, task };
}

const future = () => {
  const date = new Date(Date.now() + 3 * 86400000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace(' ', 'T');
};

test('form arguments never carry delivery options for any form input', () => {
  const schedules = [{ kind: 'cron', value: '0 8 * * *' }, { kind: 'every', value: '90m' },
    { kind: 'at', value: '2030-01-01T09:00' }, undefined];
  const extras = [{}, { replyChannel: 'telegram', replyEndpoint: '1', replySessionGroup: 'dm-1', clearReply: true,
    clearSessionGroup: true, sessionGroup: 'telegram:dm-1', target: 'telegram:x', reply: { channel: 'lark' } }];
  let checked = 0;
  for (const schedule of schedules) {
    for (const extra of extras) {
      for (const requireIdle of [true, false, undefined]) {
        for (const id of [null, 'task-abc']) {
          if (id === null && !schedule) continue;
          const form = { name: 'Daily', prompt: 'Say hi', priority: 2, missThreshold: 60, requireIdle, ...extra,
            ...(schedule ? { schedule } : {}) };
          const args = formToArgs(form, { id, tz: 'Asia/Singapore' });
          assert.equal(args.some(arg => REPLY_FLAGS.test(arg)), false, args.join(' '));
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 42);
  assert.deepEqual(formToArgs({ prompt: 'Say hi', name: 'Daily', schedule: { kind: 'at', value: '2030-01-01T09:00' } },
    { tz: 'Asia/Singapore' }), ['add', 'Say hi', '--name', 'Daily', '--at', '2030-01-01T09:00:00+08:00']);
  assert.deepEqual(formToArgs({ prompt: 'p', requireIdle: false, schedule: { kind: 'every', value: '1h' } }, { id: 'task-1' }),
    ['update', 'task-1', '--prompt', 'p', '--every', '1h', '--no-block-queue-until-idle']);
  // Only the positional content of a new task can be read as an option by the CLI.
  assert.throws(() => formToArgs({ prompt: '--- weekly report ---', schedule: { kind: 'every', value: '1h' } }, {}),
    error => error.formCode === 'prompt_starts_with_dashes');
  assert.throws(() => formToArgs({ prompt: 'x', priority: '--clear-reply', schedule: { kind: 'every', value: '1h' } }, {}),
    error => error.formCode === 'invalid_form');
  for (const missThreshold of ['1.5', '1e3']) {
    assert.throws(() => formToArgs({ prompt: 'x', missThreshold, schedule: { kind: 'every', value: '1h' } }, {}),
      error => error.formCode === 'invalid_form');
  }
  assert.deepEqual(formToArgs({ prompt: 'x', name: '--- weekly ---', schedule: { kind: 'cron', value: '--x' } }, {}),
    ['add', 'x', '--name', '--- weekly ---', '--cron', '--x']);
  assert.deepEqual(formToArgs({ prompt: '--reply-channel', schedule: { kind: 'every', value: '--every' } }, { id: 'task-1' }),
    ['update', 'task-1', '--prompt', '--reply-channel', '--every', '--every']);
  assert.throws(() => formToArgs({ prompt: 'x', schedule: { kind: 'at', value: '2030-01-01T09:00' } }, {}),
    error => error.formCode === 'tz_unavailable');
});

// Integration: the real scheduler CLI (JSON envelope) as a child process on a
// temporary scheduler.db. Run for schedule write, argv/env or CLI contract
// changes; skip rendering-only edits. Isolation from fixtures/schedule-env.js:
// temporary HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR and tmux directory, paths
// printed and asserted; each child has a 15 s timeout and the root is removed.
test('scheduler writes report done or the scheduler rejection text', async context => {
  const d = dashboard(context);
  // Writes reach scheduler.db only through the CLI child; this process only reads it.
  const statements = [];
  const prepare = Database.prototype.prepare;
  context.mock.method(Database.prototype, 'prepare', function (sql) {
    if (this.name === d.dbPath) statements.push({ sql, readonly: this.readonly });
    return prepare.call(this, sql);
  });
  const created = await d.write('POST', '/api/workbench/schedule', { name: 'Daily', prompt: 'Say hi',
    schedule: { kind: 'every', value: '2h' }, priority: '2', missThreshold: '120', requireIdle: true });
  assert.equal(created.status, 200);
  assert.equal(created.body.result, 'done');
  const id = created.body.data.task.id;
  assert.match(id, /^task-/);
  const db = d.open();
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  assert.deepEqual([row.priority, row.miss_threshold, row.require_idle, row.interval_seconds], [2, 120, 1, 7200]);
  assert.deepEqual([row.session_component, row.session_group_name, row.reply_channel, row.reply_endpoint], [null, null, null, null]);
  assert.equal(deliveryLine(await d.task(id), { t }), '在 Origin 执行 · 结果不另外发送');

  const priority = await d.write('POST', '/api/workbench/schedule', { prompt: 'x', schedule: { kind: 'every', value: '1h' }, priority: '9' });
  assert.equal(priority.status, 400);
  assert.equal(priority.body.result, 'rejected');
  assert.equal(priority.body.code, 'INVALID_ARGS');
  assert.equal(writeMessage(priority.body, t), 'Priority must be 1-3 (1=urgent, 2=high, 3=normal)');

  assert.equal((await d.write('POST', `/api/workbench/schedule/${id}/pause`)).body.result, 'done');
  const again = await d.write('POST', `/api/workbench/schedule/${id}/pause`);
  assert.deepEqual({ ...again.body, message: undefined }, { result: 'rejected', code: 'TASK_WRONG_STATUS', message: undefined, status: 'paused' });
  assert.equal((await d.write('POST', `/api/workbench/schedule/${id}/resume`)).body.result, 'done');
  assert.equal((await d.write('DELETE', `/api/workbench/schedule/${id}`)).body.result, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.ok(statements.some(item => item.readonly));
  assert.equal(statements.filter(item => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(item.sql)).length, 0);
  const dashed = await d.write('POST', '/api/workbench/schedule', { name: '--- weekly ---', prompt: 'Weekly',
    schedule: { kind: 'every', value: '1h' } });
  const dashedId = dashed.body.data.task.id;
  assert.equal((await d.write('PUT', `/api/workbench/schedule/${dashedId}`, { prompt: '--reply-channel' })).body.result, 'done');
  const stored = db.prepare('SELECT name, prompt, reply_channel, session_component FROM tasks WHERE id=?').get(dashedId);
  assert.deepEqual({ ...stored }, { name: '--- weekly ---', prompt: '--reply-channel', reply_channel: null, session_component: null });
  const positional = await d.write('POST', '/api/workbench/schedule', { name: 'Weekly', prompt: '--- weekly report ---',
    schedule: { kind: 'every', value: '1h' } });
  assert.deepEqual({ status: positional.status, result: positional.body.result, code: positional.body.code },
    { status: 400, result: 'rejected', code: 'prompt_starts_with_dashes' });
  assert.equal(writeMessage(positional.body, t), '新建任务的内容不能以 -- 开头');
  const threshold = await d.write('POST', '/api/workbench/schedule', { prompt: 'x', missThreshold: '1.5',
    schedule: { kind: 'every', value: '1h' } });
  assert.deepEqual({ status: threshold.status, code: threshold.body.code }, { status: 400, code: 'invalid_form' });
  assert.equal(writeMessage(threshold.body, t), '表单内容不合规');
  assert.equal((await d.write('POST', '/api/workbench/schedule/--json/pause')).body.code, 'invalid_task');
  assert.equal(await d.write('PATCH', '/api/workbench/schedule/task-1'), null);
});

test('an expired one-time task is re-enabled only for a future time and moves to enabled', async context => {
  const d = dashboard(context);
  const created = await d.write('POST', '/api/workbench/schedule', { name: 'Once', prompt: 'Run once',
    schedule: { kind: 'at', value: future() } });
  const id = created.body.data.task.id;
  const db = d.open();
  db.prepare("UPDATE tasks SET status='failed', last_error='Missed execution window', failed_at=1 WHERE id=?").run(id);
  const expired = await d.task(id);
  assert.equal(expired.reenable, true);
  assert.deepEqual(groupTasks([expired], { t }).map(section => section.name), ['failed']);
  const past = await d.write('PUT', `/api/workbench/schedule/${id}`, { name: 'Once', prompt: 'Run once',
    schedule: { kind: 'at', value: '2020-01-01T09:00' } });
  assert.equal(past.body.result, 'rejected');
  assert.equal(past.body.code, 'RESCHEDULE_NOT_FUTURE');
  assert.match(writeMessage(past.body, t), /^时间必须在将来 · /);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'failed');
  const done = await d.write('PUT', `/api/workbench/schedule/${id}`, { name: 'Once', prompt: 'Run once',
    schedule: { kind: 'at', value: future() } });
  assert.equal(done.body.result, 'done');
  assert.equal(done.body.data.reenabled, true);
  const row = db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id=?').get(id);
  assert.deepEqual({ ...row }, { status: 'pending', failed_at: null, last_error: null });
  assert.deepEqual(groupTasks([await d.task(id)], { t }).map(section => section.name), ['enabled']);
});

test('scheduler child output without an envelope is unknown and never retried', async () => {
  for (const reply of [
    (callback) => callback(null, 'Task created: task-1\n', ''),
    (callback) => callback(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '', ''),
    (callback) => callback(Object.assign(new Error('exit 1'), { code: 1 }), '{"ok":true}\n{"ok":true}\n', ''),
  ]) {
    const calls = [];
    const cli = createSchedulerCli({ zylosDir: '/nonexistent-zylos', env: { PATH: '/bin', ZYLOS_SESSION_GROUP: 'telegram:x' },
      execute: (file, args, options, callback) => {
        calls.push({ file, args, options });
        reply(callback);
      } });
    assert.deepEqual(await cli(['pause', 'task-1']), { result: 'unknown', reason: 'scheduler_cli_failed' });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.file, process.execPath);
    assert.deepEqual(call.args, ['/nonexistent-zylos/.claude/skills/scheduler/scripts/cli.js', 'pause', 'task-1', '--json']);
    assert.equal(call.options.env.ZYLOS_DIR, '/nonexistent-zylos');
    assert.equal('ZYLOS_SESSION_GROUP' in call.options.env, false);
    assert.equal(call.options.timeout, 15000);
    assert.equal(call.options.cwd, '/nonexistent-zylos');
  }
});

test('a Dashboard process inside a session group still creates an unrouted task', async context => {
  const d = dashboard(context, { processEnv: { ZYLOS_SESSION_GROUP: 'telegram:x' } });
  const created = await d.write('POST', '/api/workbench/schedule', { prompt: 'From dashboard', schedule: { kind: 'every', value: '1h' } });
  assert.equal(created.body.result, 'done');
  const row = d.open().prepare('SELECT session_component, session_group_name FROM tasks WHERE id=?').get(created.body.data.task.id);
  assert.deepEqual({ ...row }, { session_component: null, session_group_name: null });
});

test('delivery stays read-only and follows agent changes in two parts', async context => {
  const rows = [{ sessionGroup: 'telegram:dm-5', c4: { componentName: 'telegram' } }];
  const d = dashboard(context, { snapshotRows: rows });
  const id = (await d.write('POST', '/api/workbench/schedule', { name: 'Report', prompt: 'Report',
    schedule: { kind: 'cron', value: '0 8 * * *' } })).body.data.task.id;
  const line = async (level = 'plain') => deliveryLine(await d.task(id), { t, level });
  assert.equal(await line(), '在 Origin 执行 · 结果不另外发送');
  assert.equal(d.agent(['update', id, '--reply-channel', 'telegram', '--reply-endpoint', '1001', '--reply-session-group', 'dm-1001']).ok, true);
  assert.equal(await line(), '在 Telegram · dm-1001 执行 · 结果发到 Telegram');
  assert.equal(await line('technical'), '在 telegram:dm-1001 执行 · 结果发到 Telegram · 1001');
  assert.equal((await line()).includes('结果也发到这里'), false);
  assert.equal(d.agent(['update', id, '--reply-channel', 'telegram', '--reply-endpoint', '2002', '--reply-session-group', 'dm-1001']).ok, true);
  assert.equal(await line(), '在 Telegram · dm-1001 执行 · 结果发到 Telegram');
  assert.equal(await line('technical'), '在 telegram:dm-1001 执行 · 结果发到 Telegram · 2002');
  assert.equal(d.agent(['update', id, '--clear-session-group']).ok, true);
  assert.equal(await line(), '在 Telegram 执行 · 结果发到 Telegram');
  assert.equal(await line('technical'), '在 telegram 执行 · 结果发到 Telegram · 2002');
  const before = d.open().prepare('SELECT session_component, session_group_name, reply_channel, reply_endpoint FROM tasks WHERE id=?').get(id);
  const edited = await d.write('PUT', `/api/workbench/schedule/${id}`, { name: 'Renamed', prompt: 'Report',
    schedule: { kind: 'cron', value: '0 9 * * *' } });
  assert.equal(edited.body.result, 'done');
  const after = d.open().prepare('SELECT name, cron_expression, session_component, session_group_name, reply_channel, reply_endpoint FROM tasks WHERE id=?').get(id);
  assert.deepEqual({ ...after, name: undefined, cron_expression: undefined }, { ...before, name: undefined, cron_expression: undefined });
  assert.deepEqual([after.name, after.cron_expression], ['Renamed', '0 9 * * *']);
  assert.equal(d.agent(['update', id, '--clear-session-group', '--clear-reply']).ok, true);
  assert.equal(await line(), '在 Origin 执行 · 结果不另外发送');
});

// Permission integration: real AuthGate with in-memory API sessions only. Run for
// schedule write routes or admin classification; skip UI-only changes. No
// network, DB or children; the gate's cleanup timer is removed in teardown.
test('local read keys cannot call schedule writes but can read', async context => {
  const token = `zylos_st_${'d'.repeat(64)}`;
  const gate = new AuthGate({ auth: { enabled: true, password: 'scrypt:fixture' } }, {
    getApiSession: hash => hash === crypto.createHash('sha256').update(token).digest('hex')
      ? { api_key_id: 9, scope: 'read', expires_at: Date.now() + 60000, key_revoked_at: null } : null,
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  context.after(() => clearInterval(gate._cleanupTimer));
  const call = async (method, route) => {
    const url = new URL(route, 'http://local.test');
    const response = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status; },
      end(body) { this.body = JSON.parse(body); } };
    const handled = await gate.handle({ method, url: url.pathname, headers: { authorization: `Bearer ${token}` } }, response, url);
    return { handled, response };
  };
  for (const [method, route] of [['POST', '/api/workbench/schedule'], ['PUT', '/api/workbench/schedule/task-1'],
    ['DELETE', '/api/workbench/schedule/task-1'], ['POST', '/api/workbench/schedule/task-1/pause'],
    ['POST', '/api/workbench/schedule/task-1/resume']]) {
    const { handled, response } = await call(method, route);
    assert.equal(handled, true, route);
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'insufficient_scope', required: 'admin' });
  }
  for (const route of ['/api/workbench/schedule', '/api/workbench/schedule/task-1/history', '/api/workbench/schedule/preview?kind=cron']) {
    assert.equal((await call('GET', route)).handled, false, route);
  }
});

// Integration: actual createServer, API gate, method routing and the real
// scheduler CLI child on a temporary scheduler.db. Run for schedule route
// wiring, auth or HTTP mapping changes; skip rendering-only edits. Isolation as
// above plus a temporary Dashboard SQLite and a loopback server; only the
// scheduler CLI may start a child (asserted). Teardown closes server, store,
// auth timer and the fixture root.
test('schedule HTTP routes read, write and map errors through the real server', { timeout: 60000 }, async context => {
  const f = scheduleEnv(context);
  const dashboardDir = path.join(f.zylosDir, 'components', 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  useZylosDir(context, f.zylosDir);
  const { StateEngine } = await import('../src/lib/state-engine.js');
  const { EventLoopMonitor } = await import('../src/lib/event-loop-monitor.js');
  const { VersionChecker } = await import('../src/lib/version-checker.js');
  let engine, auth, server;
  context.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    clearInterval(auth?._cleanupTimer);
    engine?.store.close();
  });
  context.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  context.mock.method(VersionChecker.prototype, 'start', () => {});
  const children = [];
  context.mock.module('node:child_process', { namedExports: {
    ...childProcess,
    execFileSync: () => '1.0.0',
    execFile: (file, args, options, callback) => {
      children.push(args[0]);
      assert.equal(args[0], f.cliPath);
      return childProcess.execFile(file, args, options, callback);
    },
  } });
  context.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  context.mock.module('../src/lib/auth.js', { namedExports: {
    ...await import('../src/lib/auth.js'),
    AuthGate: class extends AuthGate { constructor(...args) { super(...args); auth = this; } },
  } });
  const { createServer } = await import(`../src/index.js?schedule-http=${Date.now()}`);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = scope => {
    const token = `zylos_st_${(scope === 'admin' ? 'e' : 'f').repeat(64)}`;
    const key = engine.store.insertApiKey({ name: `fixture-${scope}`, keyHash: hashApiKey(`zylos_ak_${(scope === 'admin' ? '1' : '2').repeat(64)}`), scope });
    engine.store.insertApiSession({ apiKeyId: Number(key.lastInsertRowid), tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      createdAt: Date.now(), scope, expiresAt: Date.now() + 60000 });
    return token;
  };
  const read = session('read');
  const admin = session('admin');
  const request = (route, { token = read, method = 'GET', body } = {}) => fetch(origin + route, {
    method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
  const missing = await request('/api/workbench/schedule');
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { available: false, tasks: [] });
  const form = JSON.stringify({ name: 'HTTP', prompt: 'Over HTTP', schedule: { kind: 'every', value: '1h' } });
  const denied = await request('/api/workbench/schedule', { method: 'POST', body: form });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'insufficient_scope', required: 'admin' });
  assert.equal(children.length, 0);
  const badJson = await request('/api/workbench/schedule', { token: admin, method: 'POST', body: '{' });
  assert.equal(badJson.status, 400);
  assert.deepEqual(await badJson.json(), { error: 'invalid_json' });
  const created = await request('/api/workbench/schedule', { token: admin, method: 'POST', body: form });
  assert.equal(created.status, 200);
  const id = (await created.json()).data.task.id;
  const page = await (await request('/api/workbench/schedule')).json();
  assert.equal(page.tz, 'Asia/Singapore');
  assert.deepEqual(page.tasks.map(task => [task.id, task.target.kind]), [[id, 'origin']]);
  assert.deepEqual(await (await request(`/api/workbench/schedule/${id}/history`)).json(), { rows: [], next: null });
  const limit = await request(`/api/workbench/schedule/${id}/history?limit=0`);
  assert.equal(limit.status, 400);
  assert.deepEqual(await limit.json(), { error: 'invalid_limit' });
  assert.deepEqual(await (await request('/api/workbench/schedule/preview?kind=cron&value=bad')).json(), { valid: false, error: 'invalid_cron' });
  assert.equal((await request(`/api/workbench/schedule/${id}/pause`, { token: admin, method: 'POST' })).status, 200);
  const wrong = await request(`/api/workbench/schedule/${id}/pause`, { token: admin, method: 'POST' });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, 'TASK_WRONG_STATUS');
  assert.equal((await request(`/api/workbench/schedule/${id}`, { token: admin, method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/workbench/schedule/${id}/unknown`, { token: admin, method: 'POST' })).status, 405);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(f.dbPath + suffix, { force: true });
  fs.writeFileSync(f.dbPath, 'not a database file');
  const unreadable = await request('/api/workbench/schedule');
  assert.equal(unreadable.status, 503);
  assert.deepEqual(await unreadable.json(), { error: 'scheduler_unreadable' });
  assert.equal(children.length, 4);
});


// Integration: real reader summary -> unchanged legacy form functions -> real
// scheduler CLI write. Run for summary field or edit/write contract changes;
// skip unrelated rendering edits. scheduleEnv prints/asserts isolated HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR, private tmux directory and DB paths. The CLI
// child is timeout-bounded; teardown closes handles and removes the fixture.
test('an older editor changing priority cannot write a summary back over the full task content', async context => {
  const d = dashboard(context);
  const prompt = 'Full task content. '.repeat(40) + 'Retain this final instruction.';
  const created = await d.write('POST', '/api/workbench/schedule', { name: 'Long task', prompt,
    schedule: { kind: 'every', value: '2h' }, priority: '3' });
  assert.equal(created.body.result, 'done');
  const id = created.body.data.task.id;
  const listed = (await d.reader.read()).tasks.find(task => task.id === id);
  assert.equal(Object.hasOwn(listed, 'prompt'), false);
  assert.equal(Array.from(listed.promptSummary).length, 200);
  assert.equal(listed.promptTruncated, true);
  // These form functions are unchanged from the pre-summary client version.
  const original = initialForm(listed, { tz: 'Asia/Singapore' });
  assert.equal(original.prompt, '');
  const payload = formPayload({ ...original, priority: '1' }, original);
  assert.equal(payload.prompt, '');
  const result = await d.write('PUT', `/api/workbench/schedule/${id}`, payload);
  assert.equal(result.body.result, 'done');
  const saved = d.open().prepare('SELECT priority, prompt FROM tasks WHERE id = ?').get(id);
  assert.equal(saved.priority, 1);
  assert.equal(saved.prompt, prompt);
});
