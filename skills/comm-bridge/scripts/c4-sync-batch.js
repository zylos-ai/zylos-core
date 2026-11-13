import { createHash } from 'node:crypto';
import { dataError, parseSessionGroup } from './c4-session-group.js';
import { projectConversation } from './c4-query-format.js';

const invalid = message => { throw dataError('INVALID_INPUT', message); };
const changed = message => dataError('INPUT_CHANGED', message);
const fields = ['id', 'timestamp', 'direction', 'channel', 'endpoint_id', 'content', 'session_group'];
function boundaries({ scope, after, end }) {
  if (scope !== '*' && !parseSessionGroup(scope)) invalid('Batch scope must be a valid session group or *');
  if (![after, end].every(value => Number.isSafeInteger(value) && value >= 0) || after > end) {
    invalid('Batch boundaries must be nonnegative integers with after <= end');
  }
}

// Callers supply public projected rows; do not project content a second time.
export function createBatchReceipt(rows, { scope, after, end }) {
  boundaries({ scope, after, end });
  if (!Array.isArray(rows)) invalid('Batch rows must be an array');
  const stable = [...rows].sort((a, b) => a.id - b.id).map((row, index, sorted) => {
    if (!Number.isSafeInteger(row.id) || row.id <= after || row.id > end || (index && sorted[index - 1].id === row.id)) invalid('Batch row id is duplicated or outside its boundaries');
    if (scope !== '*' && row.session_group !== scope) invalid('Batch row belongs to a different scope');
    return Object.fromEntries(fields.map(field => [field, row[field]]));
  });
  return { scope, after, end, sha256: createHash('sha256').update(JSON.stringify(stable)).digest('hex') };
}

export function verifyBatchReceipt(batch, { scope, end, database }) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) ||
      Object.keys(batch).sort().join(',') !== 'after,end,scope,sha256') invalid('Batch receipt requires exactly scope, after, end and sha256');
  boundaries(batch);
  if (batch.scope !== scope || batch.end !== end) invalid('Batch scope or end does not match the checkpoint');
  if (typeof batch.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(batch.sha256)) invalid('Batch sha256 must be a lowercase SHA-256 digest');
  const rows = database.getConversationsByRange(batch.after + 1, batch.end)
    .filter(row => row.status === 'delivered' && (scope === '*' || row.session_group === scope))
    .map(projectConversation);
  const actual = createBatchReceipt(rows, batch);
  if (actual.sha256 !== batch.sha256) invalid('Batch sha256 does not match the current projected conversation rows');
  return actual;
}

// Origin Sync receipts. Summary and raw receipts have different exact key sets,
// so neither can stand in for the other or for a group/global batch receipt.
const summaryFields = ['id', 'timestamp', 'summary', 'start_conversation_id', 'end_conversation_id', 'session_group'];
const summaryKeys = 'after,count,coverageEnd,end,scope,sha256';
const rawKeys = 'after,count,end,scope,sha256';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createOriginSummaryReceipt(checkpoints, { scope, after, end, coverageEnd }) {
  if (!parseSessionGroup(scope)) invalid('Origin receipt scope must be a valid session group');
  boundaries({ scope, after, end });
  if (!Number.isSafeInteger(coverageEnd) || coverageEnd < 0) invalid('Summary receipt coverageEnd must be a nonnegative integer');
  if (!Array.isArray(checkpoints)) invalid('Summary rows must be an array');
  const stable = [...checkpoints].sort((a, b) => a.id - b.id).map((row, index, sorted) => {
    if (!Number.isSafeInteger(row.id) || row.id <= after || row.id > end || (index && sorted[index - 1].id === row.id)) invalid('Summary checkpoint id is duplicated or outside its boundaries');
    if (row.session_group !== scope) invalid('Summary checkpoint belongs to a different scope');
    return Object.fromEntries(summaryFields.map(field => [field, row[field]]));
  });
  return { scope, after, end, coverageEnd, count: stable.length, sha256: digest(stable) };
}

export function createOriginRawReceipt(rows, { scope, after, end }) {
  if (!parseSessionGroup(scope)) invalid('Origin receipt scope must be a valid session group');
  return { ...createBatchReceipt(rows, { scope, after, end }), count: rows.length };
}

function receiptShape(receipt, keys, label) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).sort().join(',') !== keys) invalid(`${label} receipt requires exactly ${keys.split(',').join(', ')}`);
  if (typeof receipt.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.sha256)) invalid(`${label} receipt sha256 must be a lowercase SHA-256 digest`);
  if (!Number.isSafeInteger(receipt.count) || receipt.count < 0) invalid(`${label} receipt count must be a nonnegative integer`);
}

// Recompute both receipts from one database snapshot with the same selection as
// the Origin reads, then derive the cursors. Returns null when nothing advances.
export function verifyOriginReceipts({ summary, raw }, { group, database }) {
  receiptShape(summary, summaryKeys, 'Summary');
  if (raw !== undefined && raw !== null) receiptShape(raw, rawKeys, 'Raw');
  const receipts = raw ? [summary, raw] : [summary];
  for (const receipt of receipts) {
    if (receipt.scope !== group) invalid('Receipt scope does not match --group');
    boundaries(receipt);
  }
  const current = database.getOriginSyncReceiptInputs(group, { summaryAfter: summary.after, summaryEnd: summary.end, ...(raw ? { rawAfter: raw.after, rawEnd: raw.end } : {}) });
  if (summary.after !== current.checkpointId) throw changed('Summary receipt must start at the current Origin summary cursor');
  if (!current.coverageEnds.includes(summary.coverageEnd)) throw changed('Summary receipt coverage is not the coverage of its read');
  const rawLower = Math.max(current.cursorFrom, summary.coverageEnd);
  if (raw && raw.after !== rawLower) throw changed('Raw receipt must start at max(current raw cursor, summary coverage)');
  const summaryActual = createOriginSummaryReceipt(current.summaries, summary);
  if (summaryActual.count !== summary.count || summaryActual.sha256 !== summary.sha256 || (current.summaries.at(-1)?.id ?? summary.after) !== summary.end) invalid('Summary receipt does not match the current checkpoint rows');
  if (raw) {
    const actual = createOriginRawReceipt(current.rows.map(projectConversation), raw);
    if (actual.count !== raw.count || actual.sha256 !== raw.sha256) invalid('Raw receipt does not match the current projected conversation rows');
    return { syncedId: raw.end, checkpointId: summary.end };
  }
  if (summary.count === 0) return null;
  return { syncedId: Math.max(current.cursorFrom, Math.min(summary.coverageEnd, current.frontier)), checkpointId: summary.end };
}
