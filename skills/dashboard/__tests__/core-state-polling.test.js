import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SseHub } from '../src/lib/sse.js';

// Pure unit tests: Core module boundary is mocked; no tmux, PM2, network,
// databases or children. The official Node runner isolates all host paths.
async function fixture(t) {
  let runId = 'first', reads = 0;
  let unstable = false;
  const observation = group => ({
    identity: { present: true, ready: true, runtime: 'codex', runId: group === 'origin' ? runId : 'other', sessionId: `session-${group}` },
    status: { valid: !unstable, reason: unstable ? 'identity_changed' : null, value: { state: 'idle' } },
    usage: { valid: false },
  });
  const { CoreState } = await import('../src/lib/core-state.js');
  const core = new CoreState({ accountUsageCache: { read: async () => null },
    sessionObservations: { get: async () => {
      reads++;
      return { mode: 'multi', group: 'origin',
        observations: new Map(['origin', 'other'].map(group => [group, observation(group)])),
        reader: { readRuntimeHealth: async () => ({ health: 'ok' }) } };
    } } });
  t.after(() => core.stop());
  return { core, reads: () => reads, replace: () => { runId = 'second'; }, invalidate: () => { unstable = true; } };
}

function response() {
  return Object.assign(new EventEmitter(), { writeHead() {}, write() { return true; }, end() {} });
}

test('local and fleet SSE viewers sample every 2.5 seconds and stop completely after disconnect', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hub = new SseHub(15000, { onClientCountChange: count => f.core.setWatched(count > 0) });
  t.after(() => hub.closeAll());
  await f.core.start();
  t.mock.timers.tick(30000); await f.core.pending;
  assert.equal(f.reads(), 0);
  const local = response(), fleet = response();
  hub.addClient(local); hub.addClient(fleet);
  t.mock.timers.tick(2499); await f.core.pending; assert.equal(f.reads(), 0);
  t.mock.timers.tick(1); await f.core.pending; assert.equal(f.reads(), 1);
  local.emit('close');
  t.mock.timers.tick(2500); await f.core.pending; assert.equal(f.reads(), 2, 'fleet subscription keeps sampling');
  fleet.emit('close');
  t.mock.timers.tick(300000); await f.core.pending; assert.equal(f.reads(), 2);
  await f.core.stop();
  t.mock.timers.tick(30000); assert.equal(f.reads(), 2);
});

test('idle current-target reads refresh immediately and cost identities share the batch', async t => {
  const f = await fixture(t);
  await f.core.start();
  await f.core.refresh();
  assert.equal(f.core.getState().runId, 'first');
  assert.equal(JSON.parse(f.core.costKey).length, 2);
  f.replace();
  assert.equal((await f.core.currentTarget()).runId, 'second');
  assert.equal(f.reads(), 2);
  assert.equal(JSON.parse(f.core.costKey).find(([group]) => group === 'origin')[1], 'second');
  f.invalidate();
  await assert.rejects(f.core.currentTarget(), { code: 'target_unavailable' });
  assert.equal(f.core.costKey, null, 'identity changes cannot publish a trusted cost key');
});
