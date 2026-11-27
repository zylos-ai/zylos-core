import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readWorkMemory } from '../read-work-memory.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, grouped = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-control-work-memory-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'read-1', TMPDIR: root };
  delete env.ZYLOS_SESSION_GROUP;
  if (grouped) env.ZYLOS_SESSION_GROUP = 'origin';
  const memory = path.join(root, 'memory', ...(grouped ? ['session-groups', 'origin'] : []));
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'state.md'), 'captured state\n');
  return { root, env, memory, options: { env } };
}

test('working memory labels historical state and excludes retired inbox files', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.memory, 'inbox.md'), 'current inbox\n');
  fs.writeFileSync(path.join(f.memory, 'inbox.20261019T081500123Z.md'), 'old inbox segment\n');
  const files = [];
  const { data } = await readWorkMemory({ ...f.options, readFile: file => {
    files.push(path.basename(file));
    return fs.readFileSync(file);
  } });
  const state = fs.readFileSync(path.join(f.memory, 'state.md'));
  assert.equal(data.scope, 'origin');
  assert.deepEqual(data.state, { retired: true, bytes: state.length, sha256: sha(state) });
  assert.match(data.text, /state\.md \(no longer updated\)\n\ncaptured state/);
  assert.deepEqual(files, ['state.md']);
});

test('large state output spills the captured bytes into a private file', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.memory, 'state.md'), 'abc '.repeat(12000));
  const result = await readWorkMemory(f.options);
  assert.ok(Buffer.byteLength(result.output) < 32768);
  const bytes = fs.readFileSync(result.data.spill.path);
  assert.equal(bytes.length, result.data.spill.bytes);
  assert.equal(sha(bytes), result.data.spill.sha256);
  const snapshot = JSON.parse(bytes).data;
  assert.match(snapshot.text, /abc abc/);
  assert.equal(snapshot.state.bytes, 48000);
  assert.equal(fs.statSync(result.data.spill.path).mode & 0o777, 0o600);
});

test('expired total budget, non-UTF-8 state and spill failure never return partial success', async t => {
  const f = fixture(t);
  let clock = 0;
  await assert.rejects(readWorkMemory({ ...f.options, timeoutMs: 2100, now: () => clock,
    readFile: file => { clock = 2100; return fs.readFileSync(file); },
  }), error => error.code === 'READ_FAILED' && error.parts.includes('snapshot'));
  fs.writeFileSync(path.join(f.memory, 'state.md'), Buffer.from([0xff]));
  await assert.rejects(readWorkMemory(f.options), { code: 'READ_FAILED' });
  fs.writeFileSync(path.join(f.memory, 'state.md'), 'x'.repeat(40000));
  await assert.rejects(readWorkMemory({ ...f.options, writeFile: () => { throw Error('disk full'); } }),
    error => error.code === 'READ_FAILED' && error.parts[0] === 'spill');
});

test('environment scope only, global and grouped reads cannot fall back across scopes', async t => {
  const global = fixture(t, false);
  assert.equal((await readWorkMemory(global.options)).data.scope, '*');
  delete global.env.ZYLOS_RUN_ID;
  assert.equal((await readWorkMemory(global.options)).data.scope, '*');
  const f = fixture(t);
  f.env.ZYLOS_SESSION_GROUP = '';
  await assert.rejects(readWorkMemory(f.options), { code: 'SCOPE_INVALID' });
  f.env.ZYLOS_SESSION_GROUP = 'origin';
  fs.unlinkSync(path.join(f.memory, 'state.md'));
  fs.writeFileSync(path.join(f.root, 'memory/state.md'), 'wrong-scope secret marker');
  const result = await readWorkMemory(f.options);
  assert.equal(result.data.state, null);
  assert.doesNotMatch(result.data.text, /wrong-scope/);
});
