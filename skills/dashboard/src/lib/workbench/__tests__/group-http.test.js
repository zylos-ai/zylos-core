import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchGroupKey, workbenchGroupDetailKey, workbenchFailure } from '../group-http.js';

const response = error => {
  let status, body;
  workbenchFailure({ writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } }, error);
  return { status, body };
};

test('group HTTP keys decode once and retain the product key validation', () => {
  assert.equal(workbenchGroupKey('dashboard%3Aprivate'), 'dashboard:private');
  assert.equal(workbenchGroupKey('origin'), 'origin');
  assert.equal(workbenchGroupKey('runtime-overrides'), 'runtime-overrides');
  for (const key of ['%ZZ', 'telegram%3A%E8%BF%90%E7%BB%B4']) {
    assert.throws(() => workbenchGroupKey(key), { code: 'SESSION_GROUP_INVALID', statusCode: 400 });
  }
});

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


test('canonical detail decodes historic keys once while write key validation stays strict', () => {
  const key = 'telegram:运维群-测试';
  assert.equal(workbenchGroupDetailKey(encodeURIComponent(key)), key);
  assert.equal(workbenchGroupDetailKey('telegram%253Aold'), 'telegram%3Aold');
  for (const malformed of ['%ZZ', '%', '%E8%BF', '%C0%AF']) {
    assert.throws(() => workbenchGroupDetailKey(malformed), { code: 'SESSION_GROUP_INVALID', statusCode: 400 });
  }
  assert.throws(() => workbenchGroupKey(encodeURIComponent(key)), { code: 'SESSION_GROUP_INVALID', statusCode: 400 });
});
