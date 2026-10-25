import { composeSessionGroup } from './c4-session-group.js';
import { appendEntryEvent } from './c4-entry-events.js';

export async function appendOutGroupFallback(record, groupName, options = {}) {
  if (groupName === undefined || record.session_group.includes(':')) return false;
  let reason = 'SESSION_GROUP_NOT_FOUND';
  try { composeSessionGroup(record.session_group, groupName); }
  catch (error) { reason = error.code; }
  return appendEntryEvent({ event: 'out_group_fallback', conversation_id: record.id,
    channel: record.channel, endpoint: record.endpoint_id, session_group: record.session_group,
    runtime: '', reason_code: reason, detail: '' }, options);
}
