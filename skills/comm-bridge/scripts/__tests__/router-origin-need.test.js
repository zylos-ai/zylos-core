import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';

const calls = (f, kind) => f.calls.filter(row => row[0] === kind);
const originControl = (f, options = {}) => f.db.insertControl('Role instruction', { sessionGroup: 'origin', appendAckSuffix: false, ...options });
const binding = { expectedRunId: 'ended-run', tmuxTarget: { serverGeneration: 'old-server', sessionId: '$1', paneId: '%1' } };
async function startIdle(f) {
  const router = f.create(); await router.initialize(); await f.rounds(2);
  f.advance(65000); await f.rounds(2);
  return router;
}

test('a bound control cannot wake Origin; an unbound role control wakes it that round', async t => {
  const f = routerFixture(t); await startIdle(f);
  const stale = originControl(f, { targetBinding: binding });
  await f.rounds(4);
  assert.equal(calls(f, 'launch').length, 0);
  assert.equal(f.db.getControlById(stale.id).status, 'pending');
  originControl(f);
  await f.rounds(1);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(calls(f, 'launch')[0][1].sessionGroup, 'origin');
});

for (const scope of ['origin', '*']) {
  test(`${scope} drain fence prevents a demanded Origin launch`, async t => {
    const f = routerFixture(t); await startIdle(f); originControl(f);
    f.db.setDrainFence(scope, scope === '*' ? {} : { reason: 'ttl', runId: 'old-run' });
    await f.rounds(4);
    assert.equal(calls(f, 'launch').length, 0);
    assert.equal(f.router.state.resident.failures, 0);
  });
}
