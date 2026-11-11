import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupConfig } from '../src/lib/workbench/group-config.js';

const runtime = { ok: true, data: { resolved: { runtime: 'codex' } } };
const model = { ok: true, data: { resolved: { runtime: 'codex', mode: 'default' } } };
function fixture(responses = [runtime, model]) {
  const calls = [];
  const service = createGroupConfig({ zylosDir: '/isolated/instance',
    env: { HOME: '/isolated/home', ZYLOS_SESSION_GROUP: 'unrelated', RETAIN: 'yes' },
    execute: async (file, argv, options) => {
      calls.push({ file, argv, options });
      const value = responses[calls.length - 1];
      if (value instanceof Error) throw value;
      return { stdout: typeof value === 'string' ? value : JSON.stringify(value) };
    } });
  return { service, calls };
}

test('configuration reads serialize runtime before model and use the resolved target', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.get('telegram:a'), { runtime, model });
  assert.deepEqual(f.calls.map(call => call.argv), [
    ['group', 'runtime', 'get', '--group', 'telegram:a', '--json'],
    ['group', 'model', 'get', '--group', 'telegram:a', '--runtime', 'codex', '--json'],
  ]);
  for (const call of f.calls) {
    assert.equal(call.file, 'zylos');
    assert.equal(call.options.env.ZYLOS_DIR, '/isolated/instance');
    assert.equal(call.options.env.ZYLOS_SESSION_GROUP, undefined);
    assert.equal(call.options.env.RETAIN, 'yes');
    assert.equal(call.options.timeout, 15000); assert.equal(call.options.maxBuffer, 1024 * 1024);
  }
});

test('failed runtime reads preserve Core errors and never call model get', async () => {
  const error = { ok: false, error: { code: 'SESSION_GROUP_INVALID', message: 'Original Core message', persisted: [] } };
  for (const response of [error, Object.assign(new Error('nonzero'), { stdout: JSON.stringify(error) })]) {
    const f = fixture([response]);
    assert.deepEqual(await f.service.get('telegram:a'), { runtime: error, model: null });
    assert.equal(f.calls.length, 1);
  }
  const malformed = fixture([{ ok: true }]);
  assert.equal((await malformed.service.get('telegram:a')).runtime.unknown, true);
  assert.equal(malformed.calls.length, 1);
});

for (const [change, expected] of [
  [{ kind: 'runtime', value: 'inherit' }, ['group', 'runtime', 'reset', '--group', 'telegram:a', '--json']],
  [{ kind: 'runtime', value: 'claude' }, ['group', 'runtime', 'set', '--group', 'telegram:a', '--runtime', 'claude', '--json']],
  [{ kind: 'model', runtime: 'codex', reset: true }, ['group', 'model', 'reset', '--group', 'telegram:a', '--runtime', 'codex', '--json']],
  [{ kind: 'model', runtime: 'codex', model: 'model-a', effort: 'high' }, ['group', 'model', 'set', '--group', 'telegram:a', '--runtime', 'codex', '--model', 'model-a', '--effort', 'high', '--json']],
]) test(`configuration submits one ${change.kind} ${change.reset || change.value === 'inherit' ? 'reset' : 'set'}`, async () => {
  const response = { ok: true, data: { running: { status: 'pending' } } }, f = fixture([response]);
  assert.deepEqual(await f.service.submit('telegram:a', change), response);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].argv, expected);
});

test('model and effort must be a complete pair and invalid changes start no command', async () => {
  const f = fixture();
  for (const change of [null, {}, { kind: 'runtime' }, { kind: 'model', runtime: 'codex', model: 'model-a' },
    { kind: 'model', runtime: 'codex', effort: 'high' }, { kind: 'model', runtime: 'codex', model: ' ', effort: 'high' }]) {
    const result = await f.service.submit('telegram:a', change);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(f.calls.length, 0);
});

test('configuration transport failure is unknown and never automatically retries a write', async () => {
  for (const response of [Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT' }), 'not json', '{}']) {
    const f = fixture([response]);
    const result = await f.service.submit('telegram:a', { kind: 'runtime', value: 'codex' });
    assert.equal(result.ok, false); assert.equal(result.unknown, true);
    assert.equal(result.error.code, 'RESULT_UNKNOWN'); assert.equal(f.calls.length, 1);
  }
});

test('write results preserve Core running status and unknown reason without translation', async () => {
  for (const data of [
    { running: { status: 'pending' } }, { running: { status: 'unknown', reason: 'snapshot_unavailable' } },
    { running: null, sessionMode: 'single' },
    { running: null, sessionMode: 'multi', runtime: 'claude', resolved: { runtime: 'codex' } },
  ]) {
    const f = fixture([{ ok: true, data }]);
    assert.deepEqual((await f.service.submit('telegram:a', { kind: 'runtime', value: 'codex' })).data, data);
  }
});
