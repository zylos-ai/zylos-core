import { dashboardConversationId, dashboardReplyMessageId } from './dashboard-endpoint.js';

// A normal reply stays unquoted. Check the entire conversation interval,
// including messages outside the current history page.
export function dashboardReplyQuotes(rows, getDatabase) {
  const references = rows.flatMap(row => {
    if (row.channel !== 'dashboard' || row.direction !== 'out') return [];
    const target = dashboardReplyMessageId(row.endpoint_id);
    return target && target < row.id
      ? [{ reply: row.id, target, endpoint: dashboardConversationId(row.endpoint_id) }] : [];
  });
  if (!references.length) return new Map();
  const matches = getDatabase().prepare(`SELECT
      json_extract(value,'$.reply') AS reply, json_extract(value,'$.target') AS target
    FROM json_each(?) AS reference
    WHERE EXISTS (SELECT 1 FROM conversations AS owner
      WHERE owner.id > json_extract(reference.value,'$.target')
        AND owner.id < json_extract(reference.value,'$.reply')
        AND owner.channel='dashboard' AND owner.direction='in'
        AND owner.endpoint_id=json_extract(reference.value,'$.endpoint'))`).all(JSON.stringify(references));
  return new Map(matches.map(row => [row.reply, row.target]));
}
