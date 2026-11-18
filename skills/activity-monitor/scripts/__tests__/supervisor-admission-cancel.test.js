import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorAdmission, validSupervisorRequest } from '../supervisor-admission.js';
const request = { version: 1, type: 'mode_switch_cancel', requestId: 'cancel-1', runId: 'run-1' };
const forbidden = () => assert.fail('cancel must not read restart store');
for (const overrides of [{ runId: '' }, { runId: null }, { runId: undefined }, { version: 0 }, { requestId: '' }]) test(`cancel envelope rejects ${JSON.stringify(overrides)}`, async () => {
  const admission = new SupervisorAdmission({ store: { read: forbidden }, modeSwitchCancel: forbidden }); admission.openEntry();
  assert.equal(validSupervisorRequest({ ...request, ...overrides }), false);
  assert.equal((await admission.handle({ ...request, ...overrides })).code, 'invalid_request');
});
test('cancel waits for shared lifecycle queue and invokes callback once with pinned envelope', async () => {
  let unlock, calls = 0;
  const admission = new SupervisorAdmission({ store: { read: forbidden }, modeSwitchCancel: input => {
    calls++; assert.deepEqual(input, request); return { ok: true, result: 'cancelled', runId: input.runId };
  } }); admission.openEntry();
  const held = admission.serialize(() => new Promise(resolve => { unlock = resolve; }));
  await Promise.resolve(); const pending = admission.handle(request);
  await Promise.resolve(); assert.equal(calls, 0); unlock(); await held;
  assert.deepEqual(await pending, { ...request, ok: true, result: 'cancelled' }); assert.equal(calls, 1);
});
test('cancel startup and queue-time closing reject before callback', async () => {
  const admission = new SupervisorAdmission({ store: { read: forbidden }, modeSwitchCancel: forbidden });
  assert.equal((await admission.handle(request)).code, 'entry_not_open');
  admission.openEntry(); const pending = admission.handle(request); admission.closeEntry();
  assert.equal((await pending).code, 'entry_not_open');
});
for (const code of ['run_not_open', 'not_cancellable']) test(`cancel ${code} preserves matching reply envelope`, async () => {
  const admission = new SupervisorAdmission({ store: { read: forbidden }, modeSwitchCancel: () => ({ ok: false, code }) }); admission.openEntry();
  assert.deepEqual(await admission.handle(request), { version: 1, type: request.type, requestId: request.requestId, ok: false, code });
});
test('cancel callback failure does not report acceptance', async () => {
  const admission = new SupervisorAdmission({ store: { read: forbidden }, modeSwitchCancel: () => { throw new Error('busy'); } }); admission.openEntry();
  await assert.rejects(admission.handle(request), /busy/);
});
