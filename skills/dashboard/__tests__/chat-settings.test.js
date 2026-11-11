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
test('only local cookie can persist remote chat permission without losing other settings', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ untouched: 7, chat: { label: 'kept' } }));
  const f = await chatHttpFixture(t, { configPath });
  f.config.auth.enabled = false;
  assert.equal((await f.request({ method: 'PUT', path: '/api/chat/settings' }, { body: '{"allowRemote":true}' })).status, 403);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { untouched: 7, chat: { label: 'kept' } });
  f.config.auth.enabled = true;
  for (const fleet of [false, true]) for (const identity of ['read', 'admin']) for (const method of ['GET', 'PUT']) {
    const before = f.counts.upstream;
    assert.equal((await f.request({ method, path: '/api/chat/settings' }, { identity, fleet, body: '{"allowRemote":true}' })).status, 403);
    assert.equal(f.counts.upstream, before);
    assert.equal(f.config.chat.allowRemote, false);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).chat.allowRemote, undefined);
  }
  assert.equal((await f.request({ method: 'PUT', path: '/api/chat/settings' }, { origin: false })).status, 403);
  assert.equal((await f.request({ method: 'PUT', path: '/api/chat/settings' }, { body: '{"allowRemote":"true"}' })).status, 400);
  await Promise.all([
    f.request({ method: 'PUT', path: '/api/chat/settings' }, { body: '{"allowRemote":true}' }).then(r => assert.equal(r.status, 200)),
    mutateConfig(configPath, value => { value.concurrent = 'preserved'; }),
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { untouched: 7, concurrent: 'preserved', chat: { label: 'kept', allowRemote: true } });
  const previous = process.env.ZYLOS_DIR;
  const zylos = path.join(root, 'restart');
  fs.mkdirSync(path.join(zylos, 'components/dashboard'), { recursive: true });
  fs.copyFileSync(configPath, path.join(zylos, 'components/dashboard/config.json'));
  try { process.env.ZYLOS_DIR = zylos; assert.equal(loadConfig().chat.allowRemote, true); }
  finally { process.env.ZYLOS_DIR = previous; }
  assert.deepEqual(JSON.parse((await f.request({ method: 'GET', path: '/api/chat/settings' })).text), { allowRemote: true });
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
  const result = await f.request({ method: 'PUT', path: '/api/chat/settings' }, { body: '{"allowRemote":true}' });
  assert.equal(result.status, 500);
  assert.equal(f.config.chat.allowRemote, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { chat: { allowRemote: false }, kept: 7 });
});
