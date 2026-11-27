import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

test('reference reorganization retries a failed enqueue and sends only once for the same session', async () => {
  const controls = [], fences = [];
  let fail = true, now = 1_000_000;
  const lifecycle = new SupervisorLifecycle({
    db: {
      getModeTransition: () => null,
      listDrainFences: () => fences,
      insertControl: (...args) => {
        if (fail) throw new Error('Queue unavailable');
        controls.push(args);
      },
    },
    prepareReferenceReorg: () => true,
    prompts: { REFERENCE_REORG_PROMPT: 'reference proposal' },
  }, { now: () => now });
  const origin = { sessionGroup: 'origin', runId: 'reference-run', sessionId: 'reference-session', sourceScope: 'origin' };
  const context = { configuration: { mode: 'multi' }, scenes: [origin], restartRequests: [], fences };
  await assert.rejects(lifecycle.checkReferenceReorg(context), /Queue unavailable/);
  fail = false; now += 60_000;
  await lifecycle.checkReferenceReorg(context);
  now += 60_000;
  await lifecycle.checkReferenceReorg(context);
  assert.deepEqual(controls, [['reference proposal', { sessionGroup: 'origin', priority: 3, appendAckSuffix: false }]]);
});
