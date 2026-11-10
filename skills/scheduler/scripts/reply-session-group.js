import { dataError } from '../../comm-bridge/scripts/c4-session-group.js';

/** Resolve an explicit reply destination before an add/update can write it. */
export function resolveReplySessionGroup(target, explicitGroup, { query, isOrigin }) {
  if (isOrigin(target)) {
    if (explicitGroup !== undefined) throw dataError('INVALID_ARGS', 'Dashboard Origin does not accept --reply-session-group');
    return { session_component: null, session_group_name: null };
  }
  const groupName = explicitGroup === undefined ? query(target).groupName : explicitGroup;
  return { session_component: target.component, session_group_name: groupName };
}
