import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, sendJson } from '../http.js';

test('JSON failures retain diagnostics and map command rejection status', () => {
  const cases = [
    [{ ok: false, error: 'INVALID_RUNTIME' }, 400],
    [{ ok: false, error: { code: 'AUTH_FAILED', message: 'Replace rejected runtime credentials' } }, 403],
    [{ ok: false, error: { code: 'AUTH_NOT_CONFIRMED', message: 'Confirm runtime authentication' } }, 403],
    [{ ok: false, error: { code: 'INSTRUCTIONS_UNAVAILABLE', message: 'Could not rebuild runtime instructions' } }, 503],
    [{ ok: false, error: { code: 'RUNTIME_SETUP_INCOMPLETE', message: 'Runtime setup is missing or out of date' } }, 503],
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

// Actual Core configuration validation and write-error conversion, with the child
// transport injected; no filesystem, process, socket or live database is opened.
