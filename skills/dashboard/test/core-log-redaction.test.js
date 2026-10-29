import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-content-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  const importer = new CoreLogImporter({ store, zylosDir: root, ...options });
  t.after(async () => { await importer.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'receive.jsonl');
  return { root, file, store, importer, read: () => importer.importStream({ stream: 'receive', file }) };
}

test('an existing source directory without any past file remains quiet across polls', async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) await f.read();
  assert.deepEqual(f.store.getHistoryDiagnostics({ stream: 'receive' }), []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM core_log_cursors').get().n, 0);
});

test('a previously imported file disappearing reports a persistent source gap', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, ts: 1, event: 'received' }) + '\n');
  await f.read();
  fs.unlinkSync(f.file);
  await f.read();
  assert.ok(f.store.getHistoryDiagnostics({ stream: 'receive' }).some(row => row.extra.reason === 'source_missing'));
  assert.equal(f.store.queryEvents().length, 1);
});

test('content redaction processes each prepared batch once and preserves diagnostic identity', async t => {
  const f = fixture(t, { batchLines: 2 });
  const group = 'ns:task-12345678-1234-1234-1234-123456789012';
  const secret = `sk-${'a'.repeat(25)}`;
  const fields = ['sessionGroup', 'runId', 'sessionId', 'oldSessionId', 'target_run_id', 'requestId', 'request_id', 'control_id', 'conversation_id'];
  const rows = Array.from({ length: 5 }, (_, i) => ({ v: 1, ts: i, event: 'decision', runtime: 'codex',
    error: secret, ...Object.fromEntries(fields.map(field => [field, group])) }));
  fs.writeFileSync(f.file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const batchSizes = [];
  const redact = f.importer.redactContents.bind(f.importer);
  f.importer.redactContents = (records, context) => { batchSizes.push(records.length); return redact(records, context); };
  await f.read();
  assert.deepEqual(batchSizes, [2, 2, 1]);
  const events = f.store.queryEvents();
  assert.equal(events.length, 5);
  for (const event of events) {
    for (const field of fields) assert.equal(event.metadata[field], group, field);
    assert.equal(event.metadata.error, '[REDACTED]');
  }
  assert.equal(JSON.stringify(events).includes(secret), false);
});
