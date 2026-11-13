import { createHash } from 'node:crypto';
import { dataError, parseSessionGroup } from './c4-session-group.js';
import { projectConversation } from './c4-query-format.js';

const invalid = message => { throw dataError('INVALID_INPUT', message); };
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
