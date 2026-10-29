import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleStatusReader } from '../../../skills/web-console/scripts/session-status.js';
import { projectOrigin } from '../../../skills/dashboard/src/lib/core-state.js';
import { createSessionCache } from '../../../skills/dashboard/src/lib/coalesced-broadcast.js';

for (const mode of [null, 'single', 'multi']) {
  test(`Console ${mode} uses instance namespace and preserves F4`, async () => {
    const calls = [];
    const read = createConsoleStatusReader({ readSessionMode: () => ({ mode }), getChannelNamespace: name => { assert.equal(name, 'web-console'); return { namespace: 'clone-web' }; }, readSessionState: async (...args) => { calls.push(args); return { identity: { present: true, runId: 'R' }, status: { valid: true, value: { state: 'busy', extra: 3 } } }; } });
    assert.deepEqual(await read(), { state: 'busy', extra: 3, sessionGroup: mode === 'multi' ? 'clone-web' : null, runId: 'R' });
    assert.deepEqual(calls, [[mode === 'multi' ? 'clone-web' : null, { freshnessMs: 5000 }]]);
  });
}
for (const reason of ['identity_changed', 'stale', 'unparseable', 'starting']) {
  test(`Console invalid ${reason} stays unknown`, async () => {
    const read = createConsoleStatusReader({ readSessionMode: () => ({ mode: 'single' }), readSessionState: async () => ({ identity: { present: true }, status: { valid: false, reason } }) });
    assert.deepEqual(await read(), { state: 'unknown', reason, sessionGroup: null });
  });
}
test('Console absence and read errors distinct', async () => {
  const dependencies = { readSessionMode: () => ({ mode: 'single' }), readSessionState: async () => ({ identity: { present: false }, status: { valid: false } }) };
  assert.equal((await createConsoleStatusReader(dependencies)()).state, 'not_running');
  dependencies.readSessionState = async () => { throw new Error('broken'); };
  assert.deepEqual(await createConsoleStatusReader(dependencies)(), { state: 'error', message: 'broken' });
});
test('unknown runtime state cannot appear idle and usage validity stays independent', () => {
  const value = projectOrigin('origin', { identity: { present: true, runId: 'R' }, status: { valid: false, reason: 'stale' }, usage: { valid: true, value: { value: 1 } } });
  assert.equal(value.state, 'UNKNOWN'); assert.equal(value.usage.valid, true);
});
test('cost cache refreshes on identity changes and every unknown observation', () => {
  let reads = 0; const cached = createSessionCache(() => ++reads);
  assert.equal(cached('R:S'), 1); assert.equal(cached('R:S'), 1); assert.equal(cached('R:T'), 2); assert.equal(cached(null), 3); assert.equal(cached(null), 4);
});
