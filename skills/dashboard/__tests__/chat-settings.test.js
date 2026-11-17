import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chatHttpFixture } from './helpers/chat-http.js';
import { loadConfig } from '../src/lib/config.js';
import { mutateConfig } from '../src/lib/config-mutation.js';

test('remote conversation access defaults closed and only accepts persisted true', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-default-'));
  const previous = process.env.ZYLOS_DIR;
  t.after(() => { process.env.ZYLOS_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.ZYLOS_DIR = root;
  assert.equal(loadConfig().chat.allowRemote, false);
  const configPath = path.join(root, 'components/dashboard/config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  for (const value of [true, false, 'true', 1, null]) {
    fs.writeFileSync(configPath, JSON.stringify({ chat: { allowRemote: value } }));
    assert.equal(loadConfig().chat.allowRemote, value === true);
  }
});

// Integration: real config mutation and auth/proxy over private loopback, own
// temporary config/lock DB. Run for chat setting or persistence changes; skip
// CSS-only edits. No live config/PM2/tmux; resources removed in teardown.
test('read keys can read chat permission while admin can persist it without losing other settings', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ untouched: 7, chat: { label: 'kept' } }));
  const f = await chatHttpFixture(t, { configPath });
  const route = '/api/settings/chat';
  for (const identity of ['read', 'admin']) {
    const response = await f.request({ method: 'GET', path: route }, { identity });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { chat_allow_remote: false });
  }
  assert.equal((await f.request({ method: 'PUT', path: route }, { identity: 'read', body: '{"chat_allow_remote":true}' })).status, 403);
  for (const method of ['GET', 'PUT']) assert.equal((await f.request({ method, path: '/api/chat/settings' })).status, 404);
  assert.equal((await f.request({ method: 'PUT', path: route }, { origin: false })).status, 403);
  assert.equal((await f.request({ method: 'PUT', path: route }, { body: '{"chat_allow_remote":"true"}' })).status, 400);
  assert.equal((await f.request({ method: 'PUT', path: route }, { body: '{' })).status, 400);
  await Promise.all([
    f.request({ method: 'PUT', path: route }, { identity: 'admin', body: '{"chat_allow_remote":true}' }).then(r => {
      assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), { ok: true, chat_allow_remote: true });
    }),
    mutateConfig(configPath, value => { value.concurrent = 'preserved'; }),
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { untouched: 7, concurrent: 'preserved', chat: { label: 'kept', allowRemote: true } });
  assert.deepEqual(f.settingsChanges, [{ label: 'kept', allowRemote: true }]);
  assert.equal((await f.request({ method: 'PUT', path: route }, { body: '{"chat_allow_remote":false}' })).status, 200);
  assert.deepEqual(f.settingsChanges.at(-1), { label: 'kept', allowRemote: false });
  assert.equal(f.settingsChanges.length, 2);
});

// Integration: actual filesystem temporary-write failure with
// temporary config only. Run for write error handling; skip UI-only changes.
test('failed config writes keep old memory and disk permission', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-'));
  t.after(() => { fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true, force: true }); });
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, '{"chat":{"allowRemote":false},"kept":7}');
  await mutateConfig(configPath, () => {});
  fs.chmodSync(root, 0o500);
  const f = await chatHttpFixture(t, { configPath });
  const result = await f.request({ method: 'PUT', path: '/api/settings/chat' }, { body: '{"chat_allow_remote":true}' });
  assert.equal(result.status, 500);
  assert.equal(f.config.chat.allowRemote, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { chat: { allowRemote: false }, kept: 7 });
});
