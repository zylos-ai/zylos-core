import { isolateInstanceObservations } from './fixtures/object-instance-observations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// Actual HTTP entry in an isolated installation. Run for chat-settings ownership
// or instance wire contract changes; skip presentation-only edits. The runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; instance observations are stubbed before
// import and outbound HTTPS held offline. Teardown closes the listener and root.
test('remote access permission belongs to chat settings and stays out of instance reads and pushes', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-access-state-'));
  isolateInstanceObservations(t, root);
  const data = path.join(root, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  const realGet = https.get, held = [];
  let released = false;
  const offline = request => setImmediate(() => request.emit('error', new Error('offline in this test')));
  https.get = () => {
    const request = Object.assign(new EventEmitter(), { destroy() {}, end() {} });
    if (released) offline(request); else held.push(request);
    return request;
  };
  const releaseNetwork = () => { released = true; held.splice(0).forEach(offline); };
  let server;
  t.after(async () => {
    https.get = realGet;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { createServer } = await import(`../src/index.js?remote-access=${Date.now()}`);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'fixture-password' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie');
  const state = async () => {
    const response = await fetch(`${origin}/api/instance`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const instance = await response.json();
    assert.equal(Object.hasOwn(instance, 'chat_allow_remote'), false);
    const settings = await fetch(`${origin}/api/settings/chat`, { headers: { Cookie: cookie } });
    assert.equal(settings.status, 200);
    return settings.json();
  };
  const setSwitch = async allowRemote => {
    const response = await fetch(`${origin}/api/settings/chat`, { method: 'PUT',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_allow_remote: allowRemote }) });
    assert.equal(response.status, 200);
  };
  // The push stream other Dashboards follow: each instance it carries must report the switch, or a remote view
  // would show the tabs again on that push. Every push read is checked; reading stops at the first push reporting
  // the awaited value, bounded by time.
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${origin}/api/stream`, { headers: { Cookie: cookie }, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  let buffered = '';
  const nextInstance = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const end = buffered.indexOf('\n\n');
      if (end >= 0) {
        const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (!/^event: instance$/m.test(block)) continue;
        const pushed = JSON.parse(block.match(/^data: (.*)$/m)[1]);
        assert.equal(Object.hasOwn(pushed, 'chat_allow_remote'), false);
        return true;
      }
      assert.ok(Date.now() < deadline, 'an instance push within 5 s');
      let timer;
      const { value, done } = await Promise.race([reader.read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('no instance push within 5 s')), Math.max(1, deadline - Date.now()));
      })]).finally(() => clearTimeout(timer));
      assert.equal(done, false, 'the push stream stays open');
      buffered += decoder.decode(value, { stream: true });
    }
  };
  // The release check's push (the state engine's own state), sent once its requests fail. Anything pushed before
  // it is read and checked too; it is written before the settings change below is even requested.
  releaseNetwork();
  assert.equal(await nextInstance(), true, 'the instance stream starts without chat settings');
  assert.equal((await state()).chat_allow_remote, false, 'closed by default');
  await setSwitch(true);
  assert.equal((await state()).chat_allow_remote, true);
  await setSwitch(false);
  assert.equal((await state()).chat_allow_remote, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).chat.allowRemote, false);
});
