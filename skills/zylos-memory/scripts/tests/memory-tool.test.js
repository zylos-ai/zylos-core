import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createMemoryEditor, serveMemoryTools } from '../memory-mcp-server.js';
import { acquire, memoryScope } from '../sync-lock.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-tool-'));
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

test('IB53 local: group, origin and global use marker-derived target scopes', async () => {
  const group = await fixture('group', 'telegram:g-1');
  const temporary = `session-groups/telegram:g-1/state.md.${group.token}.tmp`;
  assert.equal((await group.editor(create(group.token, temporary))).ok, true);
  for (const target of ['identity.md', 'state.md', 'session-groups/telegram:g-1/state.md',
    'session-groups/telegram:g-1/inbox.md', 'session-groups/telegram:g-2/state.md.' + group.token + '.tmp']) {
    assert.equal((await group.editor(create(group.token, target))).code, 'PATH_NOT_ALLOWED');
  }
  const origin = await fixture('origin', 'origin');
  for (const target of ['identity.md', 'references.md', 'reference/projects.md', 'users/person/profile.md']) {
    assert.equal((await origin.editor(create(origin.token, target))).ok, true);
  }
  assert.equal((await origin.editor(create(origin.token, `session-groups/origin/state.md.${origin.token}.tmp`))).code, 'PATH_NOT_ALLOWED');
  const global = await fixture('global');
  for (const target of ['identity.md', `state.md.${global.token}.tmp`]) assert.equal((await global.editor(create(global.token, target))).ok, true);
  assert.equal((await global.editor(create(global.token, 'session-groups/origin/state.md'))).code, 'PATH_NOT_ALLOWED');
});

test('IB53 local: model role claims are rejected and the server environment stays bound', async () => {
  const f = await fixture('global');
  assert.equal((await f.editor({ ...create(f.token, 'identity.md'), kind: 'global' })).code, 'INVALID_INPUT');
  assert.equal((await f.editor(create('0'.repeat(32), 'identity.md'))).code, 'TOKEN_MISMATCH');
  assert.equal((await f.editor(create(undefined, 'identity.md'))).code, 'TOKEN_MISMATCH');
  const unbound = createMemoryEditor({ ZYLOS_DIR: f.dir });
  assert.equal((await unbound(create(f.token, 'identity.md'))).code, 'SCOPE_UNBOUND');
  // Server captures its own environment at startup, independent of later mutation.
  const env = { ...f.env }, captured = createMemoryEditor(env);
  env.ZYLOS_RUN_ID = 'different';
  assert.equal((await captured(create(f.token, 'identity.md'))).ok, true);
  assert.equal(fs.existsSync(path.join(f.dir, 'memory', 'state.md')), false);
});

test('IB53 local: create and fragment conflicts preserve existing files', async () => {
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

test('IB53 local: traversal, target symlinks and parent symlinks cannot escape allowed paths', async () => {
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

test('IB53 local: write failure reports failure and preserves original content', async () => {
  const f = await fixture('global');
  await f.editor(create(f.token, 'identity.md', 'original'));
  const failed = createMemoryEditor(f.env, { fragment: () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); } });
  await assert.rejects(failed({ op: 'edit', path: 'identity.md', expected: 'original', replacement: 'new', token: f.token }), /disk failure/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'memory/identity.md'), 'utf8'), 'original');
});

test('IB53 local: stdio emits only protocol frames and advertises the restricted tool', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let received = ''; output.on('data', chunk => { received += chunk; });
  const done = serveMemoryTools({ input, output, editor: async () => ({ ok: false, code: 'SCOPE_UNBOUND', message: 'unbound' }) });
  for (const request of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'edit_memory', arguments: {} } },
  ]) input.write(JSON.stringify(request) + '\n');
  input.end(); await done;
  const frames = received.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 3); assert.deepEqual(frames.map(x => x.id), [1, 2, 3]);
  assert.equal(frames[1].result.tools[0].name, 'edit_memory');
  assert.equal(frames[1].result.tools[0].inputSchema.additionalProperties, false);
  assert.equal(frames[2].result.isError, true);
  assert.equal(JSON.parse(frames[2].result.content[0].text).code, 'SCOPE_UNBOUND');
});

test('IB53 local: concurrent group editors cannot cross scope and origin tokens choose separate permissions', async () => {
  const a = await fixture('group', 'telegram:a'), b = await fixture('group', 'telegram:b', a.dir);
  const fileA = `session-groups/telegram:a/state.md.${a.token}.tmp`;
  const fileB = `session-groups/telegram:b/state.md.${b.token}.tmp`;
  assert.deepEqual((await Promise.all([a.editor(create(a.token, fileA, 'A')), b.editor(create(b.token, fileB, 'B'))])).map(result => result.ok), [true, true]);
  assert.equal((await a.editor(create(a.token, fileB))).code, 'PATH_NOT_ALLOWED');
  assert.equal((await a.editor(create(b.token, fileA))).code, 'TOKEN_MISMATCH');
  const origin = await fixture('origin', 'origin');
  const groupToken = await acquire({ kind: 'group', env: origin.env }, { currentRunId: async () => runId });
  assert.equal((await origin.editor(create(groupToken, `session-groups/origin/state.md.${groupToken}.tmp`))).ok, true);
  assert.equal((await origin.editor(create(groupToken, 'identity.md'))).code, 'PATH_NOT_ALLOWED');
  assert.equal((await origin.editor(create(origin.token, 'identity.md'))).ok, true);
});

test('IB53 local: actual stdio process exposes no authority when forwarded run env is absent', async () => {
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
