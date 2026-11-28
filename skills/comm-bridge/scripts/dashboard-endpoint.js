// Dashboard owns the conversation and message parts of its C4 reply address.
export const dashboardConversationId = endpoint => endpoint?.split('|', 1)[0];

// SQL equivalent for queries reading the stored endpoint. The caller supplies
// a column expression, never an endpoint value.
export const dashboardConversationIdSql = column => `substr(${column},1,instr(${column} || '|','|')-1)`;

export function dashboardReplyMessageId(endpoint) {
  const [conversationId, ...fields] = endpoint?.split('|') ?? [];
  if (!fields.length) return undefined;
  const match = fields.length === 1 && /^msg:([1-9][0-9]*)$/.exec(fields[0]);
  const id = match && Number(match[1]);
  return conversationId && conversationId !== 'origin' && Number.isSafeInteger(id) ? id : null;
}

export function replyEndpoint(row) {
  const endpoint = row.endpoint_id;
  return row.channel === 'dashboard' && row.direction === 'in'
    && endpoint && endpoint !== 'origin' && Number.isSafeInteger(row.id) && row.id > 0
    ? `${endpoint}|msg:${row.id}` : endpoint;
}
