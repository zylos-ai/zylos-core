import test from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';

// Caller-side health projection contract; delivery health gates belong to B.
test('restricted admission reads only the runtime health projection', async t => {
  for (const health of ['rate_limited', 'unavailable', 'recovering', 'down']) {
    await t.test(health, async t => {
      const f = routerFixture(t); f.put('origin', { runtime: 'codex' });
      const row = f.add('a'); const accessed = [];
      f.deps.readRuntimeHealth = runtime => {
        assert.equal(runtime, 'claude');
        return new Proxy({ health, publicHealth: 'unavailable' }, {
          get(target, key) {
            accessed.push(key);
            assert(['health', 'publicHealth', 'missing', 'unreadable'].includes(key), `forbidden health read: ${String(key)}`);
            return target[key];
          },
          set() { assert.fail('router must not write health'); },
        });
      };
      f.deps.submit = async request => {
        f.calls.push(['submit', request]);
        assert.equal(f.row(row.id).status, 'pending');
        return { kind: 'accepted', sent: true, reply: { ...request, ok: true, result: 'registered',
          reason: 'recovery_due', attemptAt: Math.floor(f.now() / 1000), ...(health === 'down' ? {} : { attemptCount: 1 }) } };
      };
      await f.create().initialize(); await f.rounds(4);
      assert(accessed.includes('health'));
      assert.equal(f.calls.filter(([kind]) => kind === 'submit').length, 1);
      assert.equal(f.calls.filter(([kind]) => kind === 'launch').length, 1);
      assert.equal(f.row(row.id).status, 'delivered');
    });
  }
});

test('origin and single resident startup never enter health admission', async t => {
  for (const mode of ['single', 'multi']) {
    await t.test(mode, async t => {
      const f = routerFixture(t, { mode });
      f.deps.readRuntimeHealth = () => assert.fail('resident startup has no health admission');
      f.deps.submit = () => assert.fail('resident startup does not register start_attempt');
      await f.create().initialize(); await f.rounds(2); f.advance(5000); await f.rounds(2);
      assert.equal(f.calls.filter(([kind]) => kind === 'launch').length, 1);
    });
  }
});
