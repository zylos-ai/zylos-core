import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBatchReceipt, createOriginRawReceipt, createOriginSummaryReceipt, verifyBatchReceipt, verifyOriginReceipts } from '../c4-sync-batch.js';
import { projectConversation } from '../c4-query-format.js';

const row = (id, session_group = 'foo', status = 'delivered') => ({ id, timestamp: '2026-01-01 00:00:00', direction: 'out', channel: 'system', endpoint_id: null, content: `row ${id}`, session_group, status });
const invalid = error => error.code === 'INVALID_INPUT';

describe('Sync batch receipts', () => {

  it('hashes only stable projected fields in id order and excludes failed input', () => {
    const raw = [row(1), row(2, 'bar'), { ...row(3, 'foo', 'failed'), direction: 'in' }, row(4)];
    const batch = createBatchReceipt([raw[3], raw[0]].map(projectConversation), { scope: 'foo', after: 0, end: 4 });
    const database = { getConversationsByRange(begin, end) { assert.equal(begin, 1); assert.equal(end, 4); return raw; } };
    assert.deepEqual(verifyBatchReceipt(batch, { scope: 'foo', end: 4, database }), batch);
    assert.equal(createBatchReceipt([raw[0], { ...raw[3], status: 'other', dynamic: 'ignored' }], batch).sha256, batch.sha256);
    assert.throws(() => verifyBatchReceipt({ ...batch, sha256: '0'.repeat(64) }, { scope: 'foo', end: 4, database }), { code: 'INPUT_CHANGED' });
    assert.throws(() => verifyBatchReceipt(batch, { scope: 'foo', end: 5, database }), invalid);
    assert.throws(() => verifyBatchReceipt(batch, { scope: 'bar', end: 4, database }), invalid);
    assert.throws(() => verifyBatchReceipt({ ...batch, extra: true }, { scope: 'foo', end: 4, database }), invalid);
  });

});

describe('Origin receipts', () => {
  const checkpoint = (id, summary = `summary ${id}`) => ({ id, timestamp: '2026-01-01 00:00:00', summary, start_conversation_id: 1, end_conversation_id: 2, session_group: 'foo', no_content: 0 });
  it('cover stable fields with distinct exact key sets', () => {
    const summary = createOriginSummaryReceipt([checkpoint(4), checkpoint(3)], { scope: 'foo', after: 2, end: 4, coverageEnd: 2 });
    assert.deepEqual(Object.keys(summary).sort(), ['after', 'count', 'coverageEnd', 'end', 'scope', 'sha256']);
    assert.equal(summary.count, 2);
    assert.notEqual(createOriginSummaryReceipt([checkpoint(3), checkpoint(4, 'changed')], { scope: 'foo', after: 2, end: 4, coverageEnd: 2 }).sha256, summary.sha256);
    const raw = createOriginRawReceipt([projectConversation(row(5))], { scope: 'foo', after: 4, end: 5 });
    assert.deepEqual(Object.keys(raw).sort(), ['after', 'count', 'end', 'scope', 'sha256']);
    assert.equal(raw.sha256, createBatchReceipt([projectConversation(row(5))], { scope: 'foo', after: 4, end: 5 }).sha256);
    for (const bad of [
      () => createOriginSummaryReceipt([checkpoint(5)], { scope: 'foo', after: 2, end: 4, coverageEnd: 2 }),
      () => createOriginSummaryReceipt([{ ...checkpoint(3), session_group: 'bar' }], { scope: 'foo', after: 2, end: 4, coverageEnd: 2 }),
      () => createOriginRawReceipt([], { scope: '*', after: 0, end: 0 }),
    ]) assert.throws(bad, invalid);
    // Neither receipt is accepted where the other or a group batch receipt is required.
    const database = { getOriginSyncReceiptInputs: () => assert.fail('shape is checked before reading'), getConversationsByRange: () => [] };
    assert.throws(() => verifyOriginReceipts({ summary: raw }, { group: 'foo', database }), invalid);
    assert.throws(() => verifyOriginReceipts({ summary, raw: summary }, { group: 'foo', database }), invalid);
    assert.throws(() => verifyBatchReceipt(raw, { scope: 'foo', end: 5, database }), invalid);
  });
});
