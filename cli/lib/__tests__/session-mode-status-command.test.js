import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSessionMode, sessionModeCommand } from '../../commands/session-mode.js';

for (const args of [['status', 'extra'], ['status', '--force'], ['status', '--json', '--json']]) {
  test(`status rejects invalid arguments before reads: ${JSON.stringify(args)}`, async () => {
    const unused = () => assert.fail('invalid arguments must not touch sources');
    const result = await executeSessionMode(args, { readStatus: unused, send: unused, lookup: unused });
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(result.error.persisted, []);
  });
}
test('status reads once and never submits or looks up a switch', async () => {
  let reads = 0;
  const data = { sessionMode: 'multi' };
  assert.deepEqual(await executeSessionMode(['status', '--json'], {
    readStatus: () => { reads++; return data; },
    send: () => assert.fail('status cannot submit'), lookup: () => assert.fail('status cannot recover a submission'),
  }), { ok: true, data });
  assert.equal(reads, 1);
});
test('status C4 read failure preserves its code and reports no persistence', async () => {
  const result = await executeSessionMode(['status'], {
    readStatus: () => { throw Object.assign(new Error('busy'), { code: 'DB_BUSY' }); },
  });
  assert.deepEqual(result, { ok: false, error: { code: 'DB_BUSY', message: 'busy', persisted: [] } });
});
test('status JSON failure emits one envelope and exits 1', async t => {
  const previous = process.exitCode; t.after(() => { process.exitCode = previous; });
  const lines = []; t.mock.method(console, 'log', line => lines.push(line));
  t.mock.method(console, 'error', () => assert.fail('JSON must use stdout'));
  await sessionModeCommand(['status', '--json'], { readStatus: () => { throw new Error('read failed'); } });
  assert.equal(process.exitCode, 1); assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).error.code, 'READ_FAILED');
});

test('status text success starts with the shared OK envelope prefix', async t => {
  const previous = process.exitCode; t.after(() => { process.exitCode = previous; });
  const lines = []; t.mock.method(console, 'log', line => lines.push(line));
  t.mock.method(console, 'error', () => assert.fail('success must use stdout'));
  const data = { sessionMode: 'multi', supervisor: 'reachable', globalGate: { present: false },
    transition: null, blocked: null, lastCompleted: null };
  await sessionModeCommand(['status'], { readStatus: () => data });
  assert.equal(process.exitCode ?? 0, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'OK: Session mode: multi\nSupervisor: reachable\nGlobal gate: absent\nTransition: none');
});
