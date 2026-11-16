import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, sendJson } from '../http.js';
import { scheduleReadResponse } from '../workbench/schedule-read.js';
import { createScheduleWrite } from '../workbench/schedule-write.js';
import { requireChatAccess, requireChatSettingsAccess } from '../chat/access.js';

test('JSON failures retain diagnostics and map command rejection status', () => {
  const cases = [
    [{ ok: false, error: 'INVALID_RUNTIME' }, 400],
    [{ ok: false, error: { code: 'AUTH_NOT_CONFIRMED', message: 'Confirm runtime authentication' } }, 403],
    [{ ok: false, error: 'new_upstream_failure' }, 502],
    [{ ok: false, code: 'TASK_NOT_FOUND', message: 'Task missing' }, 404],
    [{ result: 'rejected', code: 'TASK_WRONG_STATUS', message: 'Paused', status: 'paused' }, 409],
    [{ result: 'unknown', reason: 'scheduler_cli_failed' }, 502],
    [{ ok: false, error: { code: 'RESULT_UNKNOWN', message: 'No reply' }, requestId: 'request' }, 502],
  ];
  for (const [input, status] of cases) {
    const result = jsonResponse(200, input);
    assert.equal(result.status, status);
    assert.equal(result.body.ok, false);
    assert.equal(typeof result.body.error.code, 'string');
    assert.equal(typeof result.body.error.message, 'string');
    if (input.requestId) assert.equal(result.body.requestId, input.requestId);
    if (typeof input.status === 'string') assert.equal(result.body.status, input.status);
  }
  const diagnostic = jsonResponse(503, { ready: false, reason: 'supervisor_unavailable', session_mode: 'multi' });
  assert.deepEqual(diagnostic, { status: 503, body: { ready: false, reason: 'supervisor_unavailable', session_mode: 'multi',
    ok: false, error: { code: 'supervisor_unavailable', message: 'supervisor_unavailable' } } });
  assert.deepEqual(jsonResponse(400, { error: 'Invalid prices supplied' }).body,
    { ok: false, error: { code: 'invalid_request', message: 'Invalid prices supplied' } });
});

test('JSON reads retain direct data and writes always declare success', () => {
  assert.deepEqual(jsonResponse(202, { ok: true, pending: true }), { status: 202, body: { ok: true, pending: true } });
  assert.deepEqual(jsonResponse(200, { items: [] }), { status: 200, body: { items: [] } });
  assert.deepEqual(jsonResponse(200, { result: 'done', data: { id: 'task' } }, { write: true }),
    { status: 200, body: { ok: true, data: { id: 'task' } } });
  const res = { apiWrite: true, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = JSON.parse(body); } };
  sendJson(res, 200, { changed: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { changed: true, ok: true });
});

test('schedule adapters expose only object routes and action subpaths', async () => {
  const calls = [];
  const reader = Object.fromEntries(['read', 'preview', 'detail', 'history'].map(method => [method, (...args) => { calls.push([method, ...args]); return { method }; }]));
  const query = new URLSearchParams();
  assert.equal((await scheduleReadResponse(reader, '/api/schedules', query)).method, 'read');
  assert.equal((await scheduleReadResponse(reader, '/api/schedules/task-1/history', query)).method, 'history');
  assert.equal(await scheduleReadResponse(reader, '/api/workbench/schedule', query), undefined);
  for (const [valid, code, status] of [[false, 'invalid_cron', 400], [null, 'cron_preview_unavailable', 503]]) {
    await assert.rejects(scheduleReadResponse({ preview: async () => ({ valid, error: code }) }, '/api/schedules/preview', query),
      error => error.statusCode === status && error.code === code);
  }
  const writer = createScheduleWrite({ scheduleTz: async () => ({ tz: 'UTC' }), schedulerCli: async args => {
    calls.push(args); return { result: 'done', data: { task: { id: 'task-1' } } };
  } });
  const result = await writer.write('POST', '/api/schedules/task-1/actions/pause');
  assert.deepEqual(result, { status: 200, body: { ok: true, data: { task: { id: 'task-1' } } } });
  assert.deepEqual(calls.at(-1), ['pause', 'task-1']);
  assert.equal(await writer.write('POST', '/api/schedules/task-1/pause'), null);
  assert.equal(await writer.write('POST', '/api/workbench/schedule/task-1/pause'), null);
  const rejected = createScheduleWrite({ schedulerCli: async () => ({ result: 'rejected', code: 'TASK_NOT_FOUND', message: 'Missing task' }) });
  assert.deepEqual(await rejected.write('DELETE', '/api/schedules/task-1'), { status: 404,
    body: { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'Missing task' } } });
});

test('remote chat reads accept read scope while writes and settings mutation require admin', () => {
  let context = { kind: 'api', scope: 'read' };
  const auth = { enabled: true, resolveAuthContext(req) { req._authContext = context; return context; } };
  assert.equal(requireChatAccess({ method: 'GET' }, auth, { chat: { allowRemote: true } }), null);
  assert.equal(requireChatAccess({ method: 'GET' }, auth, { chat: { allowRemote: false } }).status, 403);
  assert.equal(requireChatAccess({ method: 'POST' }, auth, { chat: { allowRemote: true } }).error, 'insufficient_scope');
  assert.equal(requireChatSettingsAccess({ method: 'GET' }, auth), null);
  assert.equal(requireChatSettingsAccess({ method: 'PUT' }, auth).error, 'insufficient_scope');
  context = { kind: 'api', scope: 'admin' };
  assert.equal(requireChatSettingsAccess({ method: 'PUT' }, auth), null);
});
