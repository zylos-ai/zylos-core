import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchFailure } from '../group-http.js';

const response = error => {
  let status, body;
  workbenchFailure({ writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } }, error);
  return { status, body };
};

test('group HTTP failures preserve expected statuses and conceal internal failures', () => {
  for (const statusCode of [400, 404, 502]) {
    const actual = response(Object.assign(new Error('Expected observation failure'), { code: 'GROUP_NOT_FOUND', statusCode }));
    assert.equal(actual.status, statusCode);
    assert.deepEqual(actual.body, { ok: false, error: { code: 'GROUP_NOT_FOUND', message: 'Expected observation failure' } });
  }
  assert.deepEqual(response(new Error('private failure')), { status: 500,
    body: { ok: false, error: { code: 'internal_error', message: 'Request failed' } } });
  assert.deepEqual(response(Object.assign(new Error('Too large'), { status: 413 })), { status: 413, body: { ok: false, error: { code: 'invalid_request', message: 'Too large' } } });
});
