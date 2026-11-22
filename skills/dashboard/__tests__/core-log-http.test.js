import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { generateApiKey } from '../src/lib/auth.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';

// Exercise the real authenticated route, including filters before pagination and
// output redaction for historical records that predate importer-side redaction.
// Run when event scope, filters, importer publication or redaction changes; skip
// for unrelated UI changes. The official runner isolates HOME/ZYLOS_DIR/PM2_HOME
// and TMPDIR; this case uses only its private DB/HTTP server and stops the importer.
test('group event pages preserve scoped Origin history, the page cap and redaction', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-http-'));
  const modePath = path.join(root, '.zylos/config.json');
  fs.mkdirSync(path.dirname(modePath), { recursive: true });
  fs.writeFileSync(modePath, JSON.stringify({ session_mode: 'multi' }));
  const data = path.join(root, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  let importer;
  t.mock.module('../src/lib/core-log-importer.js', { namedExports: {
    CoreLogImporter: class extends CoreLogImporter {
      constructor(options) { super(options); importer = this; }
    }
  } });
  let createServer;
  try { ({ createServer } = await import(`../src/index.js?timeline=${Date.now()}`)); }
  finally { if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous; }
  const store = new Store(path.join(data, 'dashboard.db'));
  const secret = generateApiKey();
  const diagnosticSecret = `sk-${"a".repeat(25)}`;
  store.db.transaction(() => {
    for (let i = 0; i < 1004; i++) store.insertEvent({ id: `event-${i}`, ingest_id: `fixture:${i}`,
      timestamp: '2026-01-01T00:00:00.000Z', event_type: i % 2 ? 'x' : 'y', category: 'diagnostic',
      runtime: i % 2 ? 'codex' : 'unknown', session_group: i % 2 ? 'origin' : null,
      run_id: i % 2 ? 'run-a' : null, session_id: i % 2 ? 'session-a' : null,
      summary: `historical ${secret}`, metadata: { error: diagnosticSecret, reason: diagnosticSecret }, source: 'core-log' });
  })();
  store.upsertSourceHealth('core:fixture', 'history', 'warning', { stream: 'events:origin', reason: 'source_missing', details: secret });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/groups/origin/events`)).status, 401);
    const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'fixture-password' }) });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie);
    const get = async (query, status = 200, group = 'origin') => {
      const response = await fetch(`${origin}/api/groups/${encodeURIComponent(group)}/events?${query}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, status);
      return response.json();
    };
    const scoped = await get('runId=run-a&level=technical&limit=2');
    assert.deepEqual(scoped.items.map(row => row.id), ['event-1001', 'event-1003']);
    assert.deepEqual(Object.keys(scoped), ['items', 'nextCursor', 'afterCursor']);
    assert.equal(JSON.stringify(scoped).includes(secret), false);
    assert.equal(JSON.stringify(scoped).includes(diagnosticSecret), false);
    const older = await get(new URLSearchParams({ runId: 'run-a', level: 'technical', limit: 2, cursor: scoped.nextCursor }));
    assert.deepEqual(older.items.map(row => row.id), ['event-997', 'event-999']);
    assert.equal((await get('level=technical&limit=100')).items.length, 100);
    for (const [query, param] of [['limit=101', 'limit'], ['limit=1&limit=2', 'limit'], ['offset=1', 'offset'],
      ['since=x', 'since'], ['session_group=origin', 'session_group'], ['filter=foo', 'filter'], ['gap_limit=2', 'gap_limit']]) {
      const rejected = await get(query, 400);
      assert.deepEqual([rejected.error.code, rejected.error.param], ['invalid_parameter', param]);
    }
    const wrongScope = await get(new URLSearchParams({ runId: 'run-a', level: 'plain', cursor: scoped.nextCursor }), 400);
    assert.equal(wrongScope.error.code, 'invalid_cursor');
    fs.writeFileSync(modePath, JSON.stringify({ session_mode: 'single' }));
    const unassigned = await get('level=technical&limit=2');
    assert.deepEqual(unassigned.items.map(row => row.id), ['event-1002', 'event-1003']);
    const empty = await get(new URLSearchParams({ direction: 'after', level: 'technical', cursor: unassigned.afterCursor }));
    assert.deepEqual(empty.items, []);
    assert.equal(empty.afterCursor, unassigned.afterCursor);
    fs.writeFileSync(modePath, JSON.stringify({ session_mode: 'multi' }));
    // Capture only construction; real importer, index onImport wiring, coalescer,
    // SSE hub and authenticated HTTP stream all execute unchanged.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    let reader;
    try {
      const response = await fetch(`${origin}/api/stream`, { headers: { Cookie: cookie }, signal: abort.signal });
      assert.equal(response.status, 200);
      reader = response.body.getReader();
      const group = 'ns:task-12345678-1234-1234-1234-123456789012';
      const run = 'task-87654321-1234-1234-1234-123456789012';
      const session = 'desk-12345678-1234-1234-1234-123456789012';
      const file = path.join(root, 'identity-events.jsonl');
      fs.writeFileSync(file, JSON.stringify({ v: 1, ts: 1, event: 'post_tool_failure', runtime: 'claude',
        session_group: group, run_id: run, session_id: session, error: diagnosticSecret }) + '\n');
      await importer.importFile(`events:${group}`, file);
      let received = '';
      while (!received.includes('event: history_changed\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        received += new TextDecoder().decode(chunk.value);
      }
      const secretFile = path.join(root, 'secret-enums.jsonl');
      fs.writeFileSync(secretFile, JSON.stringify({ v: 1, ts: 2, event: diagnosticSecret,
        runtime: diagnosticSecret, session_group: 'ns:enum-check', requestId: run, sessionGroup: group }) + '\n');
      await importer.importFile('router', secretFile);
      const enumSaved = store.queryEvents({ sessionGroup: 'ns:enum-check' });
      const enumHistory = await get('level=technical', 200, 'ns:enum-check');
      assert.equal(enumSaved.length, 1);
      for (const records of [enumSaved, enumHistory.items]) {
        assert.equal(JSON.stringify(records).includes(diagnosticSecret), false);
        assert.equal(records[0].runtime, 'unknown');
        assert.equal(records[0].event_type, 'unknown');
        assert.equal(records[0].metadata.requestId, run);
        assert.equal(records[0].metadata.sessionGroup, group);
      }
      const query = new URLSearchParams({ runId: run, level: 'technical' });
      const history = await get(query, 200, group);
      assert.equal(history.items.length, 1);
      const saved = store.queryEvents({ sessionGroup: group, runId: run, sessionId: session })[0];
      for (const event of [saved, history.items[0]]) {
        assert.equal(event.session_group, group); assert.equal(event.run_id, run);
        assert.equal(event.session_id, session); assert.equal(event.metadata.stream, `events:${group}`);
        assert.equal(event.metadata.error, '[REDACTED]');
      }
    } finally {
      clearTimeout(timeout); await reader?.cancel(); abort.abort();
    }
  } finally {
    await importer.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
