import assert from 'node:assert/strict';
import test from 'node:test';
import { chatHttpFixture, chatRoutes } from './helpers/chat-http.js';

// Integration: actual auth/proxy/access with two private loopback servers and
// fixture-only sessions. Run when chat access or routes change; skip CSS-only
// changes. No live DB/PM2/tmux; test teardown closes servers and auth timer.
test('chat API keys require remote permission and admin at both instances', { timeout: 15000 }, async t => {
  const f = await chatHttpFixture(t);
  for (const allowRemote of [false, true, false]) {
    f.config.chat.allowRemote = allowRemote;
    for (const fleet of [false, true]) for (const identity of ['read', 'admin']) for (const route of chatRoutes) {
      const before = { ...f.counts };
      const result = await f.request(route, { identity, fleet });
      const allowed = identity === 'admin' && allowRemote;
      assert.equal(result.status, allowed ? 200 : 403, JSON.stringify({ route, identity, fleet, allowRemote, result }));
      if (!allowed) {
        assert.doesNotMatch(result.text, /PRIVATE_|"count"|"questions"/);
        assert.equal(f.counts.reads, before.reads); assert.equal(f.counts.receives, before.receives);
      }
      if (fleet && identity === 'read') assert.equal(f.counts.upstream, before.upstream);
    }
  }
});

// Integration: same private HTTP fixture; run for cookie/mode/ownership changes,
// skip presentation-only edits. No Core receive, PM2, tmux or live database.
test('cookie reads are local while writes require origin multi and stored ownership', async t => {
  const f = await chatHttpFixture(t);
  for (const route of chatRoutes) assert.equal((await f.request(route)).status, 200);
  const writes = chatRoutes.filter(route => route.method === 'POST');
  for (const route of writes) assert.equal((await f.request(route, { origin: false })).status, 403);
  f.setMode('single');
  for (const route of writes) assert.equal((await f.request(route)).status, 403);
  assert.equal((await f.request(chatRoutes[0])).status, 200);
  f.setMode('multi');
  for (const record of [null, { channel: 'telegram', namespace: 'dashboard-owned', localId: 'local-chat' },
    { channel: 'dashboard', namespace: 'other', localId: 'local-chat' },
    { channel: 'dashboard', namespace: 'dashboard-owned', localId: 'other' }]) {
    f.setRecord(record);
    const before = f.counts.receives;
    for (const route of writes.slice(1)) assert.equal((await f.request(route)).status, 403);
    assert.equal(f.counts.receives, before);
  }
});

// Integration: private HTTP fixture, run for auth-disabled handling changes;
// skip visual changes. Resource lifecycle is owned by fixture teardown.
test('missing authentication and disabled authentication never authorize chat', async t => {
  const f = await chatHttpFixture(t);
  for (const route of chatRoutes) assert.equal((await f.request(route, { identity: 'none' })).status, 401);
  f.config.auth.enabled = false;
  for (const route of chatRoutes) assert.equal((await f.request(route)).status, 403);
  assert.equal(f.counts.reads, 0); assert.equal(f.counts.receives, 0);
});
