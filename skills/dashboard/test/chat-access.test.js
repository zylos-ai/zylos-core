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

// Integration: independent local/remote AuthGates over private loopback. Run
// for proxy authentication changes; skip UI-only edits. Fixture owns teardown.
test('proxy refuses disabled local authentication before calling an enabled remote', async t => {
  const f = await chatHttpFixture(t, { chat: { allowRemote: true } }, {
    localConfig: { auth: { enabled: false, password: null } },
  });
  for (const identity of ['none', 'cookie', 'read', 'admin']) for (const route of chatRoutes) {
    const result = await f.request(route, { fleet: true, identity });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.text).error, 'admin_required');
    assert.deepEqual(f.counts, { reads: 0, receives: 0, upstream: 0 });
  }
  for (const identity of ['none', 'cookie']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const path of ['/api/chat/conversations', '/api/chat/conversations/', '/api/chat/future']) {
        const result = await f.request({ method, path }, { fleet: true, identity });
        assert.equal(result.status, 403, `${identity} ${method} ${path}`);
        assert.deepEqual(f.counts, { reads: 0, receives: 0, upstream: 0 });
      }
    }
  }
  assert.equal((await f.request(chatRoutes[0], { identity: 'admin' })).status, 200);
  assert.equal(f.counts.reads, 1);
  assert.equal(f.counts.upstream, 0);
});

// Integration: actual proxy origin/allowlist checks and independent remote
// permission; run for proxy write changes, skip presentation-only changes.
test('proxy cookie writes require exact origin before upstream while API admin may write', async t => {
  const f = await chatHttpFixture(t, { chat: { allowRemote: true } });
  const writes = chatRoutes.filter(route => route.method === 'POST');
  for (const origin of [null, false, 'http://127.0.0.1:1']) for (const route of writes) {
    const result = await f.request(route, { fleet: true, origin, contentType: 'text/plain' });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.text).error, 'origin_required');
    assert.deepEqual(f.counts, { reads: 0, receives: 0, upstream: 0 });
  }
  for (const route of writes) {
    assert.equal((await f.request(route, { fleet: true })).status, 200);
    assert.equal((await f.request(route, { fleet: true, identity: 'admin', origin: false })).status, 200);
  }
  assert.equal(f.counts.receives, writes.length * 2);
  assert.equal(f.counts.upstream, writes.length * 2);
});

// Integration: whole chat-prefix classification, including future paths and
// methods; run for auth/proxy route changes. Private fixture resources only.
test('proxy protects chat prefix for every method and retains explicit write allowlist', async t => {
  const f = await chatHttpFixture(t, { chat: { allowRemote: true } });
  const paths = ['/api/chat/conversations', '/api/chat/conversations/', '/api/chat/future'];
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) for (const path of paths) {
    const result = await f.request({ method, path }, { fleet: true, identity: 'read' });
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.deepEqual(f.counts, { reads: 0, receives: 0, upstream: 0 });
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) for (const path of paths) {
    const result = await f.request({ method, path }, { fleet: true });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.text).error, 'read_only_proxy');
    assert.deepEqual(f.counts, { reads: 0, receives: 0, upstream: 0 });
  }
  assert.equal((await f.request({ method: 'HEAD', path: paths[0] }, { fleet: true })).status, 404);
  assert.equal(f.counts.upstream, 1);
  for (const method of ['GET', 'PUT']) {
    const before = f.counts.upstream;
    assert.equal((await f.request({ method, path: '/api/chat/settings' }, { fleet: true })).status, 403);
    assert.equal(f.counts.upstream, before);
  }
});
