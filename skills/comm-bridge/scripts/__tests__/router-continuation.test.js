import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';

const calls = (f, kind) => f.calls.filter(row => row[0] === kind);
function continuation(f, group = 'a', runId = 'old-run') {
  const row = f.add(group);
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
  f.db.recordRunEnd(group, { runId, reason: 'unexpected' }); return group;
}
async function initialize(f) { await f.create().initialize(); await f.rounds(2); }
async function readyToStart(f) { f.advance(5000); await f.rounds(5); }

test('continuation-only group starts after preflight and receives only startup text', async t => {
  const f = routerFixture(t); f.put('origin');
  const id = continuation(f);
  const old = f.db.insertControl('old-run command', { sessionGroup: 'a', appendAckSuffix: false });
  const getAdapter = f.deps.session;
  let prompt;
  f.deps.session = { ...getAdapter, launch: async input => {
    f.calls.push(['launch', input]);
    f.put(input.sessionGroup, { runId: input.runId });
    prompt = f.db.insertControl('startup prompt', { sessionGroup: 'a', appendAckSuffix: false });
    f.current.get('a').startupControlIds = [prompt.id];
  } };
  await initialize(f);
  assert.equal(calls(f, 'launch').length, 0);
  await readyToStart(f);
  assert.equal(calls(f, 'launch').length, 1);
  assert.equal(f.db.getControlById(old.id).last_error, 'SESSION_ENDED');
  assert.deepEqual(calls(f, 'control').map(row => row[1]), [prompt.id]);
  assert.equal((f.db.listRunEndings([id])[0].continuationPending ? 'pending' : 'done'), 'done');
  assert.equal(calls(f, 'conversation').length, 0);
});

test('just-ready crashes back off while a stable runtime resets pacing', async t => {
  const f = routerFixture(t); f.put('origin'); continuation(f);
  await initialize(f); await readyToStart(f);
  const first = f.scene.get('a').runId;
  f.scene.delete('a'); await f.rounds(2);
  f.db.recordRunEnd('a', { runId: first, reason: 'unexpected' });
  await f.rounds(2); f.advance(9999); await f.rounds(2);
  assert.equal(calls(f, 'launch').length, 1);
  f.advance(1); await f.rounds(5); assert.equal(calls(f, 'launch').length, 2);
  const second = f.scene.get('a').runId;
  f.advance(60000); await f.rounds(2);
  f.scene.delete('a'); await f.rounds(2);
  f.db.recordRunEnd('a', { runId: second, reason: 'unexpected' });
  await f.rounds(2); f.advance(5000); await f.rounds(5);
  assert.equal(calls(f, 'launch').length, 3);
});
