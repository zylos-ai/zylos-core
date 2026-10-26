import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import syncFs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createJsonlStream, JSONL_MAX_BYTES, JSONL_RETENTION_MS } from '../../../../cli/lib/jsonl-stream.js';
import { createRouterDiagnostics } from '../router/diagnostics.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'router-jsonl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'router-events.jsonl') };
}
const lines = async filename => (await fs.readFile(filename, 'utf8')).trimEnd().split('\n').filter(Boolean).map(JSON.parse);

// T07: readers ignore an incomplete tail and malformed newline-delimited segments.
function completeRows(text) {
  return text.split('\n').slice(0, -1).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

test('one append write; short writes and failures preserve bytes and only report diagnostics', async t => {
  const { file, directory } = await fixture(t);
  const normal = createJsonlStream(file);
  await normal.append({ id: 1 });
  let calls = 0;
  const errors = [];
  const short = createJsonlStream(file, { write(fd, buffer) {
    calls++;
    assert(syncFs.fstatSync(fd).isFile());
    const written = syncFs.writeSync(fd, buffer, 0, 4);
    // Another writer can append before this writer notices its failure.
    syncFs.appendFileSync(file, JSON.stringify({ id: 'adjacent' }) + '\n');
    return written;
  } });
  const diagnostics = createRouterDiagnostics({ stream: short,
    receiveStream: createJsonlStream(path.join(directory, 'receive-events.jsonl')),
    stderr: text => errors.push(text) });
  assert.equal(await diagnostics.diagnostic('deliver'), false);
  assert.equal(calls, 1);
  const damaged = await fs.readFile(file, 'utf8');
  assert(damaged.includes('{"v"{"id":"adjacent"}\n'));
  assert.deepEqual(completeRows(damaged), [{ id: 1 }]);
  await normal.append({ id: 2 });
  const before = await fs.readFile(file);
  const failing = createJsonlStream(file, { write() { throw Error('injected disk failure'); } });
  const failedDiagnostics = createRouterDiagnostics({ stream: failing, stderr: text => errors.push(text) });
  assert.equal(await failedDiagnostics.diagnostic('deliver'), false);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(completeRows(before.toString()), [{ id: 1 }, { id: 2 }]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /short write/);
  assert.match(errors[1], /injected disk failure/);
  assert.deepEqual(completeRows('{"id":3}'), []);
});

function writer(file, id, signal) {
  const module = new URL('../../../../cli/lib/jsonl-stream.js', import.meta.url).href;
  const source = `import {createJsonlStream} from ${JSON.stringify(module)};
    const stream=createJsonlStream(process.argv[1]);
    for(let i=0;i<200;i++) {
      await stream.append({writer:process.argv[2],i,text:'界'.repeat(24000)});
      if(i===99) { process.send('half'); await new Promise(resolve => process.once('message',resolve)); }
    }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, file, id],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], signal });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(stderr || `writer exited ${code}`)));
  });
  const half = new Promise(resolve => child.once('message', resolve));
  return { child, done, half: Promise.race([half, done.then(() => { throw Error('writer exited before halfway'); })]) };
}

test('two processes append 200 records each, including >64 KB lines, during rotation', { timeout: 30000 }, async t => {
  const { directory, file } = await fixture(t);
  const stream = createJsonlStream(file);
  const writers = [writer(file, 'a', t.signal), writer(file, 'b', t.signal)];
  let running = true;
  const rotation = (async () => {
    while (running) { await stream.maintain(); await new Promise(resolve => setTimeout(resolve, 1)); }
  })();
  try {
    await Promise.all(writers.map(w => w.half));
    // Also establish a deterministic rotation before the second half is written.
    await stream.maintain();
    assert((await fs.readdir(directory)).some(name => /^router-events\.\d+\.jsonl$/.test(name)));
    for (const w of writers) w.child.send('continue');
    await Promise.all(writers.map(w => w.done));
  } finally {
    running = false;
    await rotation;
    for (const w of writers) if (w.child.exitCode === null) w.child.kill();
    await Promise.allSettled(writers.map(w => w.done));
  }
  const rows = [];
  let bytes = 0;
  for (const name of await fs.readdir(directory)) {
    const text = await fs.readFile(path.join(directory, name), 'utf8');
    assert(text.endsWith('\n'));
    const parsed = text.slice(0, -1).split('\n').map(JSON.parse);
    rows.push(...parsed);
    bytes += Buffer.byteLength(text);
  }
  assert.equal(rows.length, 400);
  assert.equal(new Set(rows.map(row => `${row.writer}:${row.i}`)).size, 400);
  assert(rows.every(row => ['a', 'b'].includes(row.writer) && row.i >= 0 && row.i < 200 && row.text === '界'.repeat(24000)));
  assert.equal(bytes, rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row) + '\n'), 0));
});

test('a writer opened before rename can append to the rotated file', async t => {
  const { file } = await fixture(t);
  await createJsonlStream(file).append({ id: 'before' });
  const rotated = file.replace('.jsonl', '.1800000000000.jsonl');
  let descriptor;
  const writer = createJsonlStream(file, { write(fd, buffer) {
    descriptor = fd;
    syncFs.renameSync(file, rotated);
    syncFs.appendFileSync(file, JSON.stringify({ id: 'current' }) + '\n');
    return syncFs.writeSync(fd, buffer);
  } });
  await writer.append({ id: 'late' });
  assert.throws(() => syncFs.fstatSync(descriptor), { code: 'EBADF' });
  assert.deepEqual(await lines(rotated), [{ id: 'before' }, { id: 'late' }]);
  assert.deepEqual(await lines(file), [{ id: 'current' }]);
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
