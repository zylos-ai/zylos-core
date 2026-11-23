import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { ClaudeHistory } from '../skills/dashboard/src/lib/runtime/claude/history.js';

const record = text => JSON.stringify({ type: 'assistant', timestamp: '2026-01-02T00:00:00.000Z', message: { content: text } }) + '\n';
const ids = Array.from({ length: 80 }, (_, index) => `session-${String(index).padStart(2, '0')}`);

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'history-list-'));
  let port = 0, worker;
  t.after(async () => {
    try { await worker?.terminate(); }
    finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  const zylosDir = path.join(home, 'zylos');
  await fs.mkdir(zylosDir);
  const project = new ClaudeHistory({ homeDir: home, zylosDir }).projectDir;
  await fs.mkdir(project, { recursive: true });
  const transcript = path.join(project, `${ids[0]}.jsonl`);
  const messages = Array.from({ length: 500 }, (_, index) => `Entry ${String(index).padStart(3, '0')}${index === 249 ? ' anchor needle' : ''}`);
  await Promise.all(ids.map(async (id, index) => {
    const file = path.join(project, `${id}.jsonl`);
    await fs.writeFile(file, index ? record(id) : messages.map(record).join(''));
    const seconds = 1767312000 - Math.floor(index / 3);
    await fs.utimes(file, seconds, seconds);
  }));
  const stop = async () => {
    if (!worker) return;
    const exit = once(worker, 'exit', { signal: t.signal });
    worker.postMessage('close');
    assert.deepEqual(await exit, [0]);
    worker = null;
  };
  const start = async () => {
    t.signal.throwIfAborted();
    worker = new Worker(new URL('./fixtures/observer-history-server.js', import.meta.url), { workerData: { port, home, zylosDir } });
    [port] = await once(worker, 'message', { signal: t.signal });
    return `http://127.0.0.1:${port}`;
  };
  const origin = await start();
  return { origin, messages, restart: async () => { await stop(); await start(); }, append: text => fs.appendFile(transcript, record(text)) };
}

// Run for history HTTP or transcript paging changes; skip presentation-only changes.
// Requires the isolated Node runner (private HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR).
// Only a loopback worker and synthetic transcripts are used; no tmux or database is opened.
test('history HTTP lists page isolated transcript files, authenticate cursor scope and reject invalid parameters', { timeout: 30000 }, async t => {
  const { origin, messages, append, restart } = await fixture(t);
  const read = async (route, query) => {
    const response = await fetch(`${origin}/api/observer/history/${route}?${new URLSearchParams(query)}`, { signal: t.signal });
    return { status: response.status, body: await response.json() };
  };
  const sessions = (await read('sessions', {})).body;
  assert.deepEqual(sessions.items.map(item => item.id), ids.slice(0, 50));
  const remaining = (await read('sessions', { cursor: sessions.nextCursor, session_group: 'origin' })).body;
  assert.deepEqual(remaining.items.map(item => item.id), ids.slice(50));
  assert.equal(remaining.nextCursor, null);
  assert.equal(Object.hasOwn(remaining, 'total'), false);
  assert.match(sessions.items[0].updatedAt, /Z$/);
  const session = ids[0];
  const entries = async query => (await read('entries', { session, ...query })).body;
  const bodies = page => page.items.map(item => item.fields.body.preview);
  const latest = await entries({});
  assert.deepEqual(bodies(latest), messages.slice(-50));
  assert.ok(latest.afterCursor);
  let all = bodies(latest), cursor = latest.nextCursor;
  for (let pageIndex = 0; pageIndex < 9; pageIndex++) {
    assert.ok(cursor);
    const page = await entries({ cursor });
    all = [...bodies(page), ...all];
    cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(all.length, messages.length);
  assert.ok(all.every((body, index) => body === messages[index]));
  await append('Appended entry');
  const polled = await entries({ direction: 'after', cursor: latest.afterCursor });
  assert.deepEqual(bodies(polled), ['Appended entry']);
  assert.ok(polled.afterCursor);
  assert.equal((await entries({ direction: 'after', cursor: polled.afterCursor })).items.length, 0);
  const match = (await read('search', { session, q: 'anchor needle' })).body.matches[0];
  const anchored = await entries({ anchor: match.entry, limit: 5 });
  assert.deepEqual(bodies(anchored), messages.slice(247, 252));
  assert.deepEqual(bodies(await entries({ cursor: anchored.nextCursor, limit: 2 })), messages.slice(245, 247));
  assert.deepEqual(bodies(await entries({ cursor: anchored.afterCursor, direction: 'after', limit: 2 })), messages.slice(252, 254));
  for (const [route, query] of [['entries', { session, internal: true, cursor: latest.nextCursor }],
    ['entries', { session: ids[1], cursor: latest.nextCursor }], ['sessions', { cursor: latest.nextCursor }],
    ['sessions', { session_group: 'test:other', cursor: sessions.nextCursor }], ['sessions', { cursor: `${sessions.nextCursor}.bad` }]]) {
    const rejected = await read(route, query);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'invalid_cursor');
  }
  for (const [query, param] of [['bogus=x', 'bogus'], ['limit=1&limit=2', 'limit'], ['limit=0', 'limit'],
    ['limit=101', 'limit'], ['internal=1', 'internal'], ['direction=up', 'direction'], ['anchor=o:1', 'anchor']]) {
    const rejected = await read('entries', `session=${session}&${query}`);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'invalid_parameter');
    assert.equal(rejected.body.error.param, param);
  }
  for (const [route, query] of [['sessions', {}], ['entries', { session }]]) {
    const rejected = await read(route, { ...query, include: 'total' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.param, 'include');
  }
  const invalidSession = await read('entries', { session: '../invalid' });
  assert.equal(invalidSession.status, 400);
  assert.equal(invalidSession.body.error.param, 'session');
  await restart();
  assert.equal((await read('sessions', { cursor: sessions.nextCursor })).body.error.code, 'invalid_cursor');
  assert.equal((await entries({ cursor: anchored.nextCursor })).error.code, 'invalid_cursor');
  assert.deepEqual(bodies(await entries({ anchor: match.entry, limit: 5 })), bodies(anchored));
});
