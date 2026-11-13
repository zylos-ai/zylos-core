import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBatchReceipt, verifyBatchReceipt } from '../c4-sync-batch.js';
import { projectConversation } from '../c4-query-format.js';
import { CONTENT_PREFIX } from '../c4-content-schema.js';
import fs from 'node:fs';

const row = (id, session_group = 'foo', status = 'delivered') => ({ id, timestamp: '2026-01-01 00:00:00', direction: 'out', channel: 'system', endpoint_id: null, content: `row ${id}`, session_group, status });
const invalid = error => error.code === 'INVALID_INPUT';

describe('Sync batch receipts', () => {
  it('projects raw stored content exactly once when verifying the receipt', () => {
    const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url)));
    const envelope = structuredClone(fixtures.valid.find(item => item.name === 'markdown').envelope);
    envelope.fallbackText = CONTENT_PREFIX + 'literal fallback';
    const raw = { ...row(1), content: CONTENT_PREFIX + JSON.stringify(envelope) };
    const projected = projectConversation(raw);
    assert.notEqual(projected.content, projectConversation(projected).content);
    const batch = createBatchReceipt([projected], { scope: 'foo', after: 0, end: 1 });
    assert.deepEqual(verifyBatchReceipt(batch, { scope: 'foo', end: 1, database: { getConversationsByRange: () => [raw] } }), batch);
  });

  it('hashes only stable projected fields in id order and verifies scoped delivered rows', () => {
    const raw = [row(1), row(2, 'bar'), row(3, 'foo', 'failed'), row(4)];
    const batch = createBatchReceipt([raw[3], raw[0]].map(projectConversation), { scope: 'foo', after: 0, end: 4 });
    const database = { getConversationsByRange(begin, end) { assert.equal(begin, 1); assert.equal(end, 4); return raw; } };
    assert.deepEqual(verifyBatchReceipt(batch, { scope: 'foo', end: 4, database }), batch);
    assert.equal(createBatchReceipt([raw[0], { ...raw[3], status: 'other', dynamic: 'ignored' }], batch).sha256, batch.sha256);
    assert.throws(() => verifyBatchReceipt({ ...batch, sha256: '0'.repeat(64) }, { scope: 'foo', end: 4, database }), invalid);
    assert.throws(() => verifyBatchReceipt(batch, { scope: 'foo', end: 5, database }), invalid);
    assert.throws(() => verifyBatchReceipt(batch, { scope: 'bar', end: 4, database }), invalid);
    assert.throws(() => verifyBatchReceipt({ ...batch, extra: true }, { scope: 'foo', end: 4, database }), invalid);
  });

  it('accepts empty and global batches and rejects invalid shapes and ranges', () => {
    const empty = createBatchReceipt([], { scope: 'foo', after: 4, end: 4 });
    assert.deepEqual(verifyBatchReceipt(empty, { scope: 'foo', end: 4, database: { getConversationsByRange: () => [] } }), empty);
    const rows = [row(1), row(2, 'bar')];
    const global = createBatchReceipt(rows, { scope: '*', after: 0, end: 2 });
    assert.deepEqual(verifyBatchReceipt(global, { scope: '*', end: 2, database: { getConversationsByRange: () => rows } }), global);
    for (const patch of [{ after: -1 }, { after: 3 }, { end: 1.5 }, { sha256: 'ABC' }, { scope: '!' }]) {
      assert.throws(() => verifyBatchReceipt({ ...global, ...patch }, { scope: '*', end: 2, database: {} }), invalid);
    }
    assert.throws(() => createBatchReceipt([row(2), row(2)], global), invalid);
  });
});
