import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// Actual HTTP entry with a temporary installation. Run for changes to the remote access switch
// (`chat.allowRemote`), the settings route or the state payload. The runner isolates
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; the server and the installation are removed in teardown.
// The state and its push report only the switch, so other Dashboards can hide the conversation and observer
// tabs; the refusals themselves are covered by chat-access and observer-service tests.
// State pushes leave by two paths: the settings route (and Core state changes) send /api/state's payload; the state
// engine, the release check and the installed-version refresh send the state engine's own state. This case reads
// one push of each and requires the switch in every push it reads. Outbound HTTPS is held (no network): the release
// check, started when the Dashboard module loads, fails once the case releases it, then pushes the state.

test('/api/state and the state push report the remote access switch and follow the settings route without a restart', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-access-state-'));
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
    const response = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const setSwitch = async allowRemote => {
    const response = await fetch(`${origin}/api/chat/settings`, { method: 'PUT',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ allowRemote }) });
    assert.equal(response.status, 200);
  };
  // The push stream other Dashboards follow: each state_change it carries must report the switch, or a remote view
  // would show the tabs again on that push. Every push read is checked; reading stops at the first push reporting
  // the awaited value, bounded by time.
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${origin}/api/stream`, { headers: { Cookie: cookie }, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  let buffered = '';
  const nextStateChange = async allowRemote => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const end = buffered.indexOf('\n\n');
      if (end >= 0) {
        const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (!/^event: state_change$/m.test(block)) continue;
        const pushed = JSON.parse(block.match(/^data: (.*)$/m)[1]);
        assert.equal(typeof pushed.chat_allow_remote, 'boolean', `every state_change push reports the switch: ${block.slice(0, 80)}`);
        if (pushed.chat_allow_remote === allowRemote) return true;
        continue;
      }
      assert.ok(Date.now() < deadline, `a state_change push reporting chat_allow_remote: ${allowRemote} within 5 s`);
      let timer;
      const { value, done } = await Promise.race([reader.read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no state_change push reporting chat_allow_remote: ${allowRemote} within 5 s`)), Math.max(1, deadline - Date.now()));
      })]).finally(() => clearTimeout(timer));
      assert.equal(done, false, 'the push stream stays open');
      buffered += decoder.decode(value, { stream: true });
    }
  };
  // The release check's push (the state engine's own state), sent once its requests fail. Anything pushed before
  // it is read and checked too; it is written before the settings change below is even requested.
  releaseNetwork();
  assert.equal(await nextStateChange(false), true, 'the release check\'s push reports the switch closed');
  assert.equal((await state()).chat_allow_remote, false, 'closed by default');
  await setSwitch(true);
  assert.equal(await nextStateChange(true), true, 'the push after turning it on');
  assert.equal((await state()).chat_allow_remote, true);
  await setSwitch(false);
  assert.equal(await nextStateChange(false), true, 'a later push after turning it off');
  assert.equal((await state()).chat_allow_remote, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).chat.allowRemote, false);
});
