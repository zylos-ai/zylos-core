import { parseSessionGroup, validateGroupName, dataError } from '../../comm-bridge/scripts/c4-session-group.js';
import { getComponentByNamespace } from '../../comm-bridge/scripts/c4-db.js';
import { validateChannel } from '../../comm-bridge/scripts/c4-validate.js';

const has = (value, name) => Object.hasOwn(value, name);
const empty = () => ({ session_component: null, session_group_name: null });

export function validateReplyTarget(options, { validate = validateChannel } = {}) {
  if (has(options, 'reply-session-group') && !has(options, 'reply-channel')) {
    throw dataError('INVALID_ARGS', '--reply-session-group requires --reply-channel');
  }
  if (has(options, 'reply-channel')) {
    const channel = options['reply-channel'];
    try {
      if (typeof channel !== 'string' || !channel || channel.includes('..') || /[/\\\0]/.test(channel)) throw new Error('invalid name');
      validate(channel, true);
    } catch (cause) { throw dataError('INVALID_ARGS', `invalid channel: ${String(channel)}`, { cause }); }
  }
  if (has(options, 'reply-session-group')) validateGroupName(options['reply-session-group']);
}

/** Resolve only supplied routing facts. Never allocate a namespace or consult a session. */
export function resolveSavedSessionGroup(options, { env = process.env, lookup = getComponentByNamespace, validate = validateChannel } = {}) {
  validateReplyTarget(options, { validate });
  if (has(options, 'reply-channel')) return { session_component: options['reply-channel'], session_group_name: options['reply-session-group'] ?? null };
  const group = env.ZYLOS_SESSION_GROUP;
  if (group === undefined) return empty();
  const parsed = parseSessionGroup(group);
  if (!parsed) throw dataError('SESSION_GROUP_INVALID', 'Invalid sender session group');
  if (parsed.namespace === 'origin') return empty();
  const component = lookup(parsed.namespace);
  if (!component) throw dataError('INVALID_ARGS', 'Session group namespace is not bound to a component');
  return { session_component: component, session_group_name: parsed.groupName };
}

export function updatedReplyTarget(task, options, deps = {}) {
  validateReplyTarget(options, deps);
  if (options['clear-reply']) return { reply_channel: null, reply_endpoint: null };
  if (!['reply-channel', 'reply-endpoint', 'reply-session-group'].some(key => has(options, key))) return {};
  const channel = has(options, 'reply-channel') ? options['reply-channel'] : task.reply_channel;
  const endpoint = has(options, 'reply-endpoint') ? options['reply-endpoint'] : task.reply_endpoint;
  // Endpoint-only updates reuse the saved channel without consulting the editor's group.
  const saved = channel === null ? empty() : { session_component: channel, session_group_name: options['reply-session-group'] ?? null };
  return { reply_channel: channel, reply_endpoint: endpoint, ...saved };
}
