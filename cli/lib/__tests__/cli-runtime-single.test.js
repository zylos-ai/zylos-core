import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeRuntimeSwitch, runtimeCommand, observeRuntimeGroups } from '../../commands/runtime.js';

import { runtimeAuthFixture } from './helpers/runtime-auth.js';

const old = { present: true, runtime: 'claude', launchConfig: { runtime: 'claude', mode: 'default' } };

test('runtime saves the baseline without observing a pre-migration session', async () => {
  const before = { runtime: 'claude', keep: 1 };
  const after = { ...before, runtime: 'codex' };
  let writes = 0;
  const stdout = [];
  const originalLog = console.log;
  console.log = line => stdout.push(line);
  try {
    const result = await runtimeCommand(['codex', '--json'], {
      execute: (target, flags) => executeRuntimeSwitch(target, flags, {
        read: () => ({ state: 'ok', config: before }), runtimeFor: runtimeAuthFixture,
        hooksReady: () => ({ ready: true }),
        write: update => {
          writes++;
          assert.deepEqual(update, { set: { runtime: 'codex' } });
          return { previous: before, config: after, changed: true };
        },
        observe: () => assert.fail('a pre-migration instance has no managed sessions'),
      }),
    });
    assert.equal(writes, 1);
    assert.deepEqual(result, { ok: true, data: { result: 'saved', baseline: 'codex',
      previousBaseline: 'claude', credentialsSaved: [], sessionMode: null,
      groups: [], groupsComplete: true, observationErrors: [], warnings: [] } });
    assert.deepEqual(stdout.map(line => JSON.parse(line)), [result]);
  } finally { console.log = originalLog; }
});

test('native single reports Origin and saved overrides without probing inactive groups', async () => {
  const observed = await observeRuntimeGroups('codex', 'single', {
    list: () => [],
    overrides: () => [{ sessionGroup: 'telegram:configured' }],
    identity: async group => { assert.equal(group, 'origin'); return old; },
  });
  assert.deepEqual(observed, {
    groups: [
      { sessionGroup: 'origin', inherits: true, liveRuntime: 'claude', status: 'pending_reclaim', error: null },
      { sessionGroup: 'telegram:configured', inherits: false, liveRuntime: null, status: 'override_kept', error: null },
    ],
    groupsComplete: true, observationErrors: [],
  });
});
