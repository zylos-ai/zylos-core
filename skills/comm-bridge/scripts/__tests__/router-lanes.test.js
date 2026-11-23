import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';
const pump = async f => { for (let i = 0; i < 4; i++) { f.router.tick(); await flush(); } };

test('one blocked delivery does not prevent another ready lane or new activation', async t => {
  for (const existing of [true, false]) await t.test(`B existing=${existing}`, async t => {
    const f = routerFixture(t); f.put('origin'); f.put('a'); if (existing) f.put('b');
    const a = f.add('a'), b = f.add('b'); const hold = deferred(); const delivered = [];
    f.deps.deliverConversation = async (row, live) => { if (row.id === a.id) await hold.promise;
      delivered.push(row.id); f.db.markDelivered(row.id, { sessionId: live.sessionId }); };
    const router = f.create(); await router.initialize(); await pump(f);
    assert.equal(f.row(a.id).status, 'running'); assert.equal(f.row(b.id).status, 'delivered');
    assert.deepEqual(delivered, [b.id]);
    hold.resolve(); await router.idle(); assert.deepEqual(delivered, [b.id, a.id]);
  });
});

test('recovery control before startup prompt before triggering conversation; clear reloads identity', async t => {
  const f = routerFixture(t); f.put('origin'); const row = f.add('a');
  const launch = f.deps.session;
  f.deps.session = { ...launch, launch: async input => {
    await launch.launch(input);
    const prompt = f.db.insertControl('prompt', { sessionGroup: 'a', priority: 2, appendAckSuffix: false });
    const recovery = f.db.insertControl('recovery', { sessionGroup: 'a', priority: 0, bypassState: true, appendAckSuffix: false });
    f.current.get('a').startupControlIds = [prompt.id];
    f.calls.push(['expected', recovery.id, prompt.id]);
  } };
  const router = f.create(); await router.initialize(); await f.rounds(7);
  const expected = f.calls.find(x => x[0] === 'expected').slice(1);
  assert.deepEqual(f.calls.filter(x => x[0] === 'control').map(x => x[1]), expected);
  assert.equal(f.row(row.id).status, 'delivered');
  const prompt2 = f.db.insertControl('clear prompt', { sessionGroup: 'a', appendAckSuffix: false });
  f.put('a', { runId: f.scene.get('a').runId, sessionId: 'clear-id' });
  f.current.get('a').startupControlIds = [prompt2.id]; const later = f.add('a'); await f.rounds(4);
  assert.equal(f.row(later.id).session_id, 'clear-id');
  assert.equal(f.calls.findIndex(x => x[0] === 'control' && x[1] === prompt2.id) < f.calls.findIndex(x => x[0] === 'conversation' && x[1] === later.id), true);
});
