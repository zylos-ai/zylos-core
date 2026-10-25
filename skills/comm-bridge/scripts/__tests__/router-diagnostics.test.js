import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonlStream, lockJsonlFile, JSONL_MAX_BYTES, JSONL_RETENTION_MS } from '../../../../cli/lib/jsonl-stream.js';
import { createRouterDiagnostics } from '../router/diagnostics.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'router-jsonl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'router-events.jsonl') };
}
const lines = async filename => (await fs.readFile(filename, 'utf8')).trimEnd().split('\n').filter(Boolean).map(JSON.parse);

// IF10-11a: real inode locks, short writes, rollback, rotation and retention.
test('JSONL short writes complete the line and failed writes restore the previous length', async t => {
  const { file } = await fixture(t);
  const normal = createJsonlStream(file);
  await normal.append({ id: 1 });
  const short = createJsonlStream(file, { write: (fd, buffer, offset) => fd.write(buffer, offset, Math.min(3, buffer.length - offset), null) });
  await short.append({ id: 2, text: 'longer than one write' });
  let calls = 0;
  const failing = createJsonlStream(file, { write: async (fd, buffer, offset) => {
    if (calls++) throw new Error('injected write failure');
    return fd.write(buffer, offset, 4, null);
  } });
  await assert.rejects(failing.append({ id: 3 }), /injected/);
  assert.deepEqual((await lines(file)).map(row => row.id), [1, 2]);
});

test('a writer waiting on the old inode reopens after rotation', async t => {
  const { file } = await fixture(t);
  await createJsonlStream(file).append({ old: true });
  let entered;
  const opened = new Promise(resolve => { entered = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  let locks = 0;
  const writer = createJsonlStream(file, { lock: async fd => {
    if (locks++ === 0) { entered(); await gate; }
    return lockJsonlFile(fd);
  } });
  const pending = writer.append({ fresh: true });
  await opened;
  const { rotated } = await createJsonlStream(file, { maxBytes: 1 }).maintain();
  resume();
  await pending;
  assert.deepEqual(await lines(rotated), [{ old: true }]);
  assert.deepEqual(await lines(file), [{ fresh: true }]);
  assert.equal(locks, 2);
});

test('positive controls detect unlocked interleaving and an omitted inode check', async t => {
  const { directory, file } = await fixture(t);
  async function concurrent(filename, lock) {
    const write = async (fd, buffer, offset) => {
      const result = await fd.write(buffer, offset, 1, null);
      await new Promise(resolve => setImmediate(resolve));
      return result;
    };
    const first = createJsonlStream(filename, { lock, write });
    const second = createJsonlStream(filename, { lock, write });
    await Promise.all([first.append({ text: 'a'.repeat(100) }), second.append({ text: 'b'.repeat(100) })]);
    return lines(filename);
  }
  assert.equal((await concurrent(file, lockJsonlFile)).length, 2);
  await assert.rejects(concurrent(path.join(directory, 'unlocked.jsonl'), async () => async () => {}), SyntaxError);

  const sourcePath = new URL('../../../../cli/lib/jsonl-stream.js', import.meta.url);
  const source = await fs.readFile(sourcePath, 'utf8');
  const check = 'if (!current || !sameFile(opened, current)) continue;';
  assert(source.includes(check));
  const mutantSource = source.replace(check, '/* known-bad: no inode check */')
    .replace("'./config-lock.js'", JSON.stringify(new URL('./config-lock.js', sourcePath).href));
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
  const mutantFile = path.join(directory, 'mutant.jsonl');
  await createJsonlStream(mutantFile).append({ old: true });
  let opened, resume;
  const entry = new Promise(resolve => { opened = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const writer = mutant.createJsonlStream(mutantFile, { lock: async fd => { opened(); await gate; return lockJsonlFile(fd); } });
  const pending = writer.append({ fresh: true });
  await entry;
  const { rotated } = await createJsonlStream(mutantFile, { maxBytes: 1 }).maintain();
  resume();
  await pending;
  const rotatedRows = await lines(rotated);
  assert.throws(() => assert.deepEqual(rotatedRows, [{ old: true }]), assert.AssertionError);
});

test('10 MiB and seven day boundaries only affect this stream rotations', async t => {
  const { directory, file } = await fixture(t);
  const stamp = 1800000000000;
  const stream = createJsonlStream(file, { now: () => stamp });
  await fs.writeFile(file, Buffer.alloc(JSONL_MAX_BYTES));
  assert.equal((await stream.maintain()).rotated, null);
  await fs.appendFile(file, '\n');
  assert.equal((await stream.maintain()).rotated, path.join(directory, `router-events.${stamp}.jsonl`));
  const expired = `router-events.${stamp - JSONL_RETENTION_MS - 1}.jsonl`;
  const boundary = `router-events.${stamp - JSONL_RETENTION_MS}.jsonl`;
  const unrelated = `receive-events.${stamp - JSONL_RETENTION_MS - 1}.jsonl`;
  for (const name of [expired, boundary, unrelated, 'router-events.unknown.jsonl']) await fs.writeFile(path.join(directory, name), '{}\n');
  assert.equal((await stream.maintain()).removed, 1);
  const remaining = await fs.readdir(directory);
  assert(!remaining.includes(expired));
  for (const name of [boundary, unrelated, 'router-events.unknown.jsonl']) assert(remaining.includes(name));
});

// #16b: per-process dedup only; an unavailable diagnostic never rejects routing.
test('router fields, wait_health dedup and failures have no diagnostic read dependency', async t => {
  const { file, directory } = await fixture(t);
  const stream = createJsonlStream(file);
  const receiveStream = createJsonlStream(path.join(directory, 'receive-events.jsonl'));
  const diagnostics = createRouterDiagnostics({ stream, receiveStream, now: () => 1234 });
  for (const [group, code] of [['a','AUTH'], ['a','AUTH'], ['b','AUTH'], ['a','RATE']]) {
    await diagnostics.diagnostic('wait_health', { sessionGroup: group, code });
  }
  await diagnostics.diagnostic('deliver', { sessionGroup: 'a', conversationId: 42, sessionId: 'session' });
  const rows = await lines(file);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[3], { v: 1, ts: 1234, event: 'deliver', session_group: 'a', conversation_id: 42, session_id: 'session', decision: 'deliver', reason: null });
  await createRouterDiagnostics({ stream, receiveStream }).diagnostic('wait_health', { sessionGroup: 'a', code: 'AUTH' });
  assert.equal((await lines(file)).length, 5);
  const errors = [];
  const bad = createRouterDiagnostics({ stream: { append() { throw Error('disk'); } }, receiveStream, stderr: text => errors.push(text) });
  assert.equal(await bad.diagnostic('activate_new'), false);
  assert.equal(errors.length, 1);
});
