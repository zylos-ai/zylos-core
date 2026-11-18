import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, sendJson, sendCommandJson } from '../http.js';
import { scheduleReadResponse } from '../workbench/schedule-read.js';
import { configFunctions } from '../../../../comm-bridge/scripts/c4-store-config.js';
import { createGroupConfig } from '../workbench/group-config.js';
import { createGroupActions } from '../workbench/group-actions.js';
import { createScheduleWrite } from '../workbench/schedule-write.js';
import { requireChatAccess, requireChatSettingsAccess } from '../chat/access.js';

test('JSON failures retain diagnostics and map command rejection status', () => {
  const cases = [
    [{ ok: false, error: 'INVALID_RUNTIME' }, 400],
    [{ ok: false, error: { code: 'AUTH_FAILED', message: 'Replace rejected runtime credentials' } }, 403],
    [{ ok: false, error: { code: 'AUTH_NOT_CONFIRMED', message: 'Confirm runtime authentication' } }, 403],
    [{ ok: false, error: 'new_upstream_failure' }, 502],
    [{ ok: false, code: 'TASK_NOT_FOUND', message: 'Task missing' }, 404],
    [{ result: 'rejected', code: 'TASK_WRONG_STATUS', message: 'Paused', status: 'paused' }, 409],
    [{ result: 'unknown', reason: 'scheduler_cli_failed' }, 502],
    [{ ok: false, error: { code: 'RESULT_UNKNOWN', message: 'No reply' }, requestId: 'request' }, 502],
  ];
  for (const [input, status] of cases) {
    const result = jsonResponse(200, input, { command: true });
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

test('JSON reads retain direct data and successful writes declare success', () => {
  assert.deepEqual(jsonResponse(202, { ok: true, pending: true }), { status: 202, body: { ok: true, pending: true } });
  assert.deepEqual(jsonResponse(200, { items: [] }), { status: 200, body: { items: [] } });
  assert.deepEqual(jsonResponse(200, { result: 'done', data: { id: 'task' } }, { write: true, command: true }),
    { status: 200, body: { ok: true, data: { id: 'task' } } });
  const res = { apiWrite: true, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = JSON.parse(body); } };
  sendJson(res, 200, { changed: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { changed: true, ok: true });
});

test('ordinary JSON writes retain explicit failures', () => {
  const payload = { ok: false, error: { code: 'invalid_value', message: 'Invalid setting' } };
  assert.deepEqual(jsonResponse(200, payload, { write: true }), { status: 400, body: payload });
  const res = { apiWrite: true, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  sendJson(res, 200, payload);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, payload);
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

test('remote chat content requires admin while the access setting remains readable', () => {
  let context = { kind: 'api', scope: 'read' };
  const auth = { enabled: true, resolveAuthContext(req) { req._authContext = context; return context; } };
  assert.equal(requireChatAccess({ method: 'GET' }, auth, { chat: { allowRemote: true } }).error, 'insufficient_scope');
  assert.equal(requireChatAccess({ method: 'GET' }, auth, { chat: { allowRemote: false } }).status, 403);
  assert.equal(requireChatAccess({ method: 'POST' }, auth, { chat: { allowRemote: true } }).error, 'insufficient_scope');
  assert.equal(requireChatSettingsAccess({ method: 'GET' }, auth), null);
  assert.equal(requireChatSettingsAccess({ method: 'PUT' }, auth).error, 'insufficient_scope');
  context = { kind: 'api', scope: 'admin' };
  assert.equal(requireChatSettingsAccess({ method: 'PUT' }, auth), null);
});


test('ordinary JSON data is not interpreted as a command result', () => {
  const payload = { ok: false, result: 'rejected', error: 'diagnostic', code: 'example', reason: 'sample', status: 200 };
  assert.deepEqual(jsonResponse(200, payload), { status: 200, body: payload });
  assert.deepEqual(jsonResponse(200, { ok: true, status: 200, services: [] }, { write: true }),
    { status: 200, body: { ok: true, services: [] } });
  assert.deepEqual(jsonResponse(200, { result: 'done', status: 200, services: [] }, { write: true, command: true }),
    { status: 200, body: { ok: true, services: [] } });
  const missingTarget = jsonResponse(200, { ok: false, error: { code: 'CONTROL_TARGET_REQUIRED', message: 'Choose a control target' } }, { command: true });
  assert.equal(missingTarget.status, 503);
  assert.equal(missingTarget.body.error.code, 'CONTROL_TARGET_REQUIRED');
});


test('restart admission stale target reaches HTTP as a conflict with the current run', async () => {
  const action = createGroupActions({ zylosDir: '/isolated/instance',
    loadCoreModule: async name => name === 'config.js'
      ? { readSessionMode: () => ({ mode: 'multi' }) }
      : { submit: async () => ({ kind: 'rejected', reply: { ok: false, result: 'stale_target', currentRunId: 'current-run' } }) },
  });
  const outcome = await action('telegram:example', 'restart', { runId: 'previous-run' });
  const res = { apiWrite: true, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  sendCommandJson(res, 200, outcome);
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'stale_target');
  assert.equal(res.body.currentRunId, 'current-run');
});


// Actual Core configuration validation and write-error conversion, with the child
// transport injected; no filesystem, process, socket or live database is opened.
test('Core model validation and configuration storage failures retain their HTTP categories', async () => {
  const { api } = configFunctions({ dependencies: { validateModel: () => false },
    write: () => { throw Object.assign(new Error('Private storage failure'), { code: 'DB_WRITE_FAILED' }); },
  });
  const cases = [
    [() => api.setSessionModelConfig({ runtime: 'claude', model: '', effort: 'high' }), 'MODEL_PAIR_REQUIRED', 400],
    [() => api.setSessionModelConfig({ runtime: 'claude', model: 'bad-model', effort: 'high' }), 'MODEL_CONFIG_INVALID', 400],
    [() => api.setSessionRuntimeConfig({ runtime: 'claude', sessionGroup: 'origin' }), 'CONFIG_STORE_FAILED', 500],
  ];
  for (const [produce, code, status] of cases) {
    const config = createGroupConfig({ zylosDir: '/isolated/instance', execute: async () => {
      try { produce(); assert.fail('The real Core producer must reject'); }
      catch (error) { return { stdout: JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) }; }
    } });
    const outcome = await config.submit('origin', { kind: 'runtime', value: 'claude' });
    assert.equal(outcome.error.code, code);
    const res = { apiWrite: true, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    sendCommandJson(res, 200, outcome);
    assert.equal(res.status, status);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, code);
  }
  for (const [code, status] of [['SESSION_GROUP_INVALID', 400], ['SESSION_GROUP_TOO_LONG', 400], ['SESSION_GROUP_NOT_FOUND', 404]]) {
    assert.equal(jsonResponse(200, { ok: false, error: { code } }, { command: true }).status, status);
  }
});


test('automatic naming command refusals keep their sanitized code and sentence with HTTP failure status', async () => {
  const { createNamingRequest } = await import('../workbench/naming-request.js');
  for (const [reply, code, message, status] of [
    [{ ok: false, error: { code: 'CONTROL_TARGET_REQUIRED', message: '/private/core/path' } }, 'CONTROL_TARGET_REQUIRED', 'C4 did not queue the naming prompt', 503],
    [{ ok: false, error: { code: 'OTHER_REJECTION', message: '/private/core/path' } }, 'OTHER_REJECTION', 'C4 did not queue the naming prompt', 502],
    [null, 'RESULT_UNKNOWN', 'Core returned no result envelope', 502],
  ]) {
    const send = createNamingRequest({ zylosDir: '/isolated/instance', readMode: () => 'multi', log: () => {},
      execute: async () => ({ stdout: JSON.stringify(reply) }) });
    const res = { apiWrite: true, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    sendCommandJson(res, 200, await send());
    assert.equal(res.status, status);
    assert.deepEqual(res.body.error, { code, message });
    assert.equal(res.body.ok, false);
    assert.equal(JSON.stringify(res.body).includes('/private'), false);
  }
});
