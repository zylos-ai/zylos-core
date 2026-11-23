import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryEditor } from '../memory-mcp-server.js';
import { acquire, memoryScope } from '../sync-lock.js';

for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(process.env[key]);
  assert.equal(path.resolve(process.env[key]).startsWith(path.resolve(os.userInfo().homedir) + path.sep), false);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-tool-'));
console.log('Memory tool test isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, fixtureRoot: root, tmux: 'unused', database: 'unused' }));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const runId = '11111111-1111-4111-8111-111111111111';
async function fixture(kind, group, sharedRoot) {
  const dir = sharedRoot ?? fs.mkdtempSync(path.join(root, kind));
  const env = { ...process.env, ZYLOS_DIR: dir, ZYLOS_RUN_ID: runId };
  if (group) env.ZYLOS_SESSION_GROUP = group; else delete env.ZYLOS_SESSION_GROUP;
  const currentRunId = async () => runId;
  const token = await acquire({ kind, env }, { currentRunId });
  return { env, token, dir, editor: createMemoryEditor(env), scope: await memoryScope(env) };
}
const create = (token, file, replacement = 'content') => ({ op: 'create', path: file, replacement, token });

test('local: group, origin and global use marker-derived target scopes', async () => {
  const group = await fixture('group', 'telegram:g-1');
  const temporary = `session-groups/telegram:g-1/state.md.${group.token}.tmp`;
  assert.equal((await group.editor(create(group.token, temporary))).ok, true);
  for (const target of ['identity.md', 'state.md', 'session-groups/telegram:g-1/state.md',
    'session-groups/telegram:g-1/inbox.md', 'session-groups/telegram:g-2/state.md.' + group.token + '.tmp']) {
    assert.equal((await group.editor(create(group.token, target))).code, 'PATH_NOT_ALLOWED');
  }
  const origin = await fixture('origin', 'origin');
  for (const target of ['identity.md', 'references.md', 'reference/projects/example.md', 'users/person/profile.md']) {
    assert.equal((await origin.editor(create(origin.token, target))).ok, true);
  }
  assert.equal((await origin.editor(create(origin.token, `session-groups/origin/state.md.${origin.token}.tmp`))).code, 'PATH_NOT_ALLOWED');
  const global = await fixture('global');
  for (const target of ['identity.md', `state.md.${global.token}.tmp`]) assert.equal((await global.editor(create(global.token, target))).ok, true);
  assert.equal((await global.editor(create(global.token, 'session-groups/origin/state.md'))).code, 'PATH_NOT_ALLOWED');
});

test('local: model role claims are rejected and the server environment stays bound', async () => {
  const f = await fixture('global');
  assert.equal((await f.editor({ ...create(f.token, 'identity.md'), kind: 'global' })).code, 'INVALID_INPUT');
  assert.equal((await f.editor(create('0'.repeat(32), 'identity.md'))).code, 'TOKEN_MISMATCH');
  const unbound = createMemoryEditor({ ZYLOS_DIR: f.dir });
  assert.equal((await unbound(create(f.token, 'identity.md'))).code, 'SCOPE_UNBOUND');
  // Server captures its own environment at startup, independent of later mutation.
  const env = { ...f.env }, captured = createMemoryEditor(env);
  env.ZYLOS_RUN_ID = 'different';
  assert.equal((await captured(create(f.token, 'identity.md'))).ok, true);
  assert.equal(fs.existsSync(path.join(f.dir, 'memory', 'state.md')), false);
});

test('local: create and fragment conflicts preserve existing files', async () => {
  const f = await fixture('global');
  assert.equal((await f.editor(create(f.token, 'identity.md', 'left middle right'))).ok, true);
  assert.equal((await f.editor(create(f.token, 'identity.md', 'overwrite'))).code, 'EXISTS');
  const edit = (expected, replacement) => f.editor({ op: 'edit', path: 'identity.md', expected, replacement, token: f.token });
  assert.equal((await edit('', 'oops')).code, 'FRAGMENT_CONFLICT');
  assert.equal((await edit('absent', 'oops')).code, 'FRAGMENT_CONFLICT');
  assert.equal((await edit('middle', 'changed')).ok, true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'memory/identity.md'), 'utf8'), 'left changed right');
  assert.equal((await f.editor(create(f.token, 'references.md', ''))).ok, true);
  assert.equal((await f.editor({ op: 'edit', path: 'references.md', expected: '', replacement: 'index', token: f.token })).ok, true);
});

test('local: traversal, target symlinks and parent symlinks cannot escape allowed paths', async () => {
  const f = await fixture('global');
  const memory = path.join(f.dir, 'memory');
  fs.mkdirSync(memory, { recursive: true });
  const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'identity.md'), 'protected');
  fs.symlinkSync(path.join(outside, 'identity.md'), path.join(memory, 'identity.md'));
  fs.symlinkSync(outside, path.join(memory, 'reference'));
  for (const target of ['../outside/new.md', '/tmp/new.md', 'identity.md', 'reference/new.md']) {
    assert.equal((await f.editor(create(f.token, target))).code, 'PATH_NOT_ALLOWED');
  }
  assert.equal(fs.readFileSync(path.join(outside, 'identity.md'), 'utf8'), 'protected');
  assert.equal(fs.existsSync(path.join(outside, 'new.md')), false);
});

// Integration boundary: real stdio RPC retains environment-bound authorization.
// Run for editor authorization/protocol changes; skip for unrelated memory text.
// The runner paths are checked and printed above. No tmux or database is used;
// execFileSync has a timeout and the enclosing after hook removes all fixtures.
test('local: actual stdio process exposes no authority when forwarded run env is absent', async () => {
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env };
  delete env.ZYLOS_RUN_ID; delete env.ZYLOS_SESSION_GROUP;
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edit_memory', arguments: create('0'.repeat(32), 'identity.md') } },
  ];
  const output = execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../memory-mcp-server.js')], {
    env, input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8', timeout: 5000,
  });
  const frames = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].result.protocolVersion, '2024-11-05');
  assert.equal(JSON.parse(frames[1].result.content[0].text).code, 'SCOPE_UNBOUND');
});

test('local: legacy paths are read-only for create and edit before path permissions', async () => {
  for (const [kind, group] of [['global', undefined], ['origin', 'origin'], ['group', 'telegram:legacy']]) {
    const f = await fixture(kind, group);
    for (const name of ['reference/projects.md', 'reference/decisions.md', 'reference/legacy/stored.md']) {
      const target = path.join(f.dir, 'memory', name);
      assert.equal((await f.editor(create(f.token, name))).code, 'LEGACY_READ_ONLY');
      assert.equal(fs.existsSync(target), false);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'unchanged');
      assert.equal((await f.editor({ op: 'edit', path: name, expected: 'unchanged', replacement: 'new', token: f.token })).code, 'LEGACY_READ_ONLY');
      assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
    }
    assert.equal((await f.editor(create('0'.repeat(32), 'reference/projects.md'))).code, 'TOKEN_MISMATCH');
    assert.equal((await f.editor(create(f.token, 'reference/projects/../projects.md'))).code, 'LEGACY_READ_ONLY');
  }
});
