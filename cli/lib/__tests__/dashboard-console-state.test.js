import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleStatusReader } from '../../../skills/web-console/scripts/session-status.js';
import { createCoreActions } from '../../../skills/dashboard/src/lib/core-actions.js';
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
const modeLoader = async () => ({ readSessionMode: () => ({ mode: 'multi' }) });
test('chop-chop freezes target and delays second submission without waiting delivery', async () => {
  const calls = []; let slept = false; const body = { runId: 'R', sessionId: 'S', sessionGroup: 'origin' };
  const action = createCoreActions({ load: modeLoader, sleep: async ms => { assert.equal(ms, 500); slept = true; body.runId = 'NEW'; }, exec: async (_, args) => { calls.push(args); if (calls.length === 2) assert.equal(slept, true); return { stdout: JSON.stringify({ ok: true, data: { id: calls.length } }) }; } });
  const result = await action('chop-chop', body, { zylosDir: '/isolated' });
  assert.equal(result.steps.length, 2);
  for (const args of calls) { assert.equal(args[args.indexOf('--target-run')+1], 'R'); assert.equal(args[args.indexOf('--expected-session')+1], 'S'); }
  assert.equal(calls[1][calls[1].indexOf('--content')+1], 'continue');
});
for (const stdout of ['', JSON.stringify({ ok: false, error: { code: 'STALE_TARGET' } })]) {
  test(`first control failure never sends second: ${stdout || 'lost response'}`, async () => {
    let count = 0;
    const action = createCoreActions({ load: modeLoader, exec: async () => { count++; throw Object.assign(new Error('timeout'), { stdout }); }, sleep: async () => assert.fail('must not delay') });
    const result = await action('chop-chop', { runId: 'R' }, { zylosDir: '/isolated' });
    assert.equal(count, 1); assert.equal(result.ok, false); assert.equal(result.submission, stdout ? 'rejected' : 'unknown');
  });
}
test('second changed target returns distinct step outcomes', async () => {
  let count = 0; const action = createCoreActions({ load: modeLoader, sleep: async () => {}, exec: async () => ({ stdout: JSON.stringify(++count === 1 ? { ok: true, data: { id: 1 } } : { ok: false, error: { code: 'TARGET_MISMATCH', runId: 'NEW' } }) }) });
  const result = await action('chop-chop', { runId: 'R' }, { zylosDir: '/isolated' });
  assert.equal(result.steps[0].ok, true); assert.equal(result.targetChanged, true); assert.equal(result.error.runId, 'NEW');
});
test('targetless and foreign group controls rejected before subprocess', async () => {
  const action = createCoreActions({ load: modeLoader, exec: () => assert.fail('must not execute') });
  assert.equal((await action('interrupt', {}, {})).error, 'TARGET_REQUIRED');
  assert.equal((await action('interrupt', { runId: 'R', sessionGroup: 'other' }, {})).error, 'TARGET_SCOPE_MISMATCH');
});
test('unknown runtime state cannot appear idle and usage validity stays independent', () => {
  const value = projectOrigin('origin', { identity: { present: true, runId: 'R' }, status: { valid: false, reason: 'stale' }, usage: { valid: true, value: { value: 1 } } });
  assert.equal(value.state, 'UNKNOWN'); assert.equal(value.usage.valid, true);
});
test('cost cache refreshes on identity changes and every unknown observation', () => {
  let reads = 0; const cached = createSessionCache(() => ++reads);
  assert.equal(cached('R:S'), 1); assert.equal(cached('R:S'), 1); assert.equal(cached('R:T'), 2); assert.equal(cached(null), 3); assert.equal(cached(null), 4);
});
