import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleStatusReader } from '../scripts/session-status.js';

test('Console status keeps startup, missing, and running identities distinct', async () => {
  let observation = { identity: { present: true, runId: 'R1' }, status: { valid: false, reason: 'starting' } };
  const read = createConsoleStatusReader({ readSessionMode: () => ({ mode: 'single' }), readSessionState: async () => observation });
  assert.deepEqual(await read(), { state: 'unknown', reason: 'starting', sessionGroup: null });
  observation = { identity: { present: false }, status: { valid: false, reason: 'not_running' } };
  assert.equal((await read()).state, 'not_running');
  observation = { identity: { present: true, runId: 'R2' }, status: { valid: true, value: { state: 'busy', detail: 'safe' } } };
  assert.deepEqual(await read(), { state: 'busy', detail: 'safe', sessionGroup: null, runId: 'R2' });
});
