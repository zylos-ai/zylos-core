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
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi' }) };
    if (name === 'session-state-reader.js') return {
      readSessionStates: async (groups, options) => {
        reads++;
        assert.deepEqual(groups, ['origin']);
        assert.deepEqual(options, { freshnessMs: 5000, includeAllLive: true });
        return new Map(['origin', 'other'].map(group => [group, observation(group)]));
      },
      resolveTargetRuntime: async () => 'codex',
      readRuntimeHealth: async () => ({ health: 'ok' }),
      readAccountUsageSnapshot: async () => ({ live: null, recorded: null }),
    };
    assert.fail(`Unexpected module: ${name}`);
  } } });
  const { CoreState } = await import(`../src/lib/core-state.js?polling=${Math.random()}`);
  const core = new CoreState();
  t.after(() => core.stop());
  return { core, reads: () => reads, replace: () => { runId = 'second'; }, invalidate: () => { unstable = true; } };
}

function response() {
  return Object.assign(new EventEmitter(), { writeHead() {}, write() { return true; }, end() {} });
}

test('local and fleet SSE viewers switch polling between one and thirty seconds', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hub = new SseHub(15000, { onClientCountChange: count => f.core.setWatched(count > 0) });
  t.after(() => hub.closeAll());
  await f.core.start();
  t.mock.timers.tick(29999); await f.core.pending;
  assert.equal(f.reads(), 1);
  t.mock.timers.tick(1); await f.core.pending;
  assert.equal(f.reads(), 2);
  const local = response(), fleet = response();
  hub.addClient(local); hub.addClient(fleet);
  t.mock.timers.tick(999); await f.core.pending; assert.equal(f.reads(), 2);
  t.mock.timers.tick(1); await f.core.pending; assert.equal(f.reads(), 3);
  local.emit('close');
  t.mock.timers.tick(1000); await f.core.pending; assert.equal(f.reads(), 4, 'fleet subscription keeps fast polling');
  fleet.emit('close');
  t.mock.timers.tick(29999); await f.core.pending; assert.equal(f.reads(), 4);
  t.mock.timers.tick(1); await f.core.pending; assert.equal(f.reads(), 5);
  await f.core.stop();
  t.mock.timers.tick(30000); assert.equal(f.reads(), 5);
});

test('idle current-target reads refresh immediately and cost identities share the batch', async t => {
  const f = await fixture(t);
  await f.core.start();
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
