import { composeSessionGroup, parseSessionGroup, requireGroup, validNamespace, dataError, isDataError } from './c4-session-group.js';
import { configFunctions } from './c4-store-config.js';
import { deliveryFunctions } from './c4-store-delivery.js';
import { progressFunctions } from './c4-store-progress.js';
import { controlFunctions } from './c4-store-control.js';
import { transitionFunctions } from './c4-store-transition.js';
import { createTargetBindingBuilder } from './c4-target-binding.js';

// Dependencies are private implementation inputs, never business API options.
export function createStore(database, dependencies = {}) {
  const db = typeof database === 'function' ? database : () => database;
  const now = dependencies.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  let poisoned = false;
  function connection() {
    if (poisoned) throw dataError('DB_WRITE_FAILED', 'Connection is unusable after rollback failure', { persisted: null });
    return db();
  }
  function read(operation) {
    try { return operation(connection()); }
    catch (error) {
      if (error.code?.startsWith('SQLITE_BUSY')) throw dataError('DB_BUSY', error.message, { cause: error });
      throw error;
    }
  }
  function transaction(operation, write = true) {
    const c = connection();
    try { c.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); }
    catch (error) {
      if (error.code?.startsWith('SQLITE_BUSY')) throw dataError('DB_BUSY', error.message, { cause: error });
      if (write) throw dataError('DB_WRITE_FAILED', error.message, { cause: error });
      throw error;
    }
    try {
      const result = operation(c);
      c.exec('COMMIT');
      return result;
    } catch (error) {
      try { c.exec('ROLLBACK'); }
      catch (rollbackError) {
        poisoned = true;
        error.rollbackError = rollbackError;
        error.persisted = null;
        try { c.close(); } catch { /* Retain the original and rollback errors. */ }
        throw error;
      }
      if (isDataError(error)) { error.persisted = []; throw error; }
      if (error.code?.startsWith('SQLITE_BUSY')) throw dataError('DB_BUSY', error.message, { cause: error });
      if (!write) throw error;
      throw dataError('DB_WRITE_FAILED', error.message, { cause: error });
    }
  }
  const write = operation => transaction(operation);
  const snapshot = operation => transaction(operation, false);
  const get = (c, sql, ...args) => c.prepare(sql).get(...args);
  const all = (c, sql, ...args) => c.prepare(sql).all(...args);
  const run = (c, sql, ...args) => c.prepare(sql).run(...args);
  const exists = (c, group) => group === 'origin' || !!get(c, 'SELECT 1 FROM group_heads WHERE session_group=?', group);
  function knownGroup(c, group) {
    requireGroup(group);
    if (!exists(c, group)) throw dataError('SESSION_GROUP_NOT_FOUND', 'Session group does not exist');
  }
  function installed(name) {
    if (typeof name !== 'string' || !name || name.includes('..') || /[/\\\0]/.test(name)) throw dataError('INVALID_ARGS', `invalid channel: ${name}`);
    try {
      if (typeof dependencies.validateComponent !== 'function' || dependencies.validateComponent(name) === false) throw new Error('Component directory is unavailable');
    } catch (cause) { throw dataError('INVALID_ARGS', `invalid channel: ${name}`, { cause }); }
  }
  const binding = (c, name) => get(c, 'SELECT component_name AS componentName,namespace FROM channel_namespaces WHERE component_name=?', name) ?? null;
  function ensure(c, name) {
    installed(name);
    const old = binding(c, name); if (old) return old;
    let base = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!/^[a-z]/.test(base)) base = `c-${base}`;
    base = base.slice(0, 32);
    for (let i = 1; ; i++) {
      const suffix = i === 1 ? '' : `-${i}`;
      const namespace = base.slice(0, 32 - suffix.length) + suffix;
      if (!validNamespace(namespace) || get(c, 'SELECT 1 FROM channel_namespaces WHERE namespace=?', namespace)) continue;
      run(c, 'INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)', namespace, name);
      return { componentName: name, namespace };
    }
  }
  function resolve(c, direction, channel, endpointId, { groupName, handoffGroup } = {}) {
    if (!['in', 'out'].includes(direction) || channel === 'internal') throw dataError('INVALID_ARGS', 'Invalid message source');
    if (channel === 'void' && direction === 'out') {
      if (!handoffGroup) throw dataError('NO_SESSION_ENV', 'The recording session is required');
      if (!parseSessionGroup(handoffGroup) || !exists(c, handoffGroup)) throw dataError('UNKNOWN_GROUP', 'Unknown recording group');
      return handoffGroup;
    }
    if (handoffGroup !== undefined) throw dataError('INVALID_ARGS', 'handoffGroup is reserved for Core void output');
    if (channel === 'system') return 'origin';
    const { namespace } = ensure(c, channel);
    if (direction === 'in') return composeSessionGroup(namespace, groupName);
    if (groupName !== undefined) {
      try { const group = composeSessionGroup(namespace, groupName); if (exists(c, group)) return group; } catch (error) { if (!['SESSION_GROUP_INVALID','SESSION_GROUP_TOO_LONG'].includes(error.code)) throw error; }
      dependencies.log?.('out_group_fallback', { channel, groupName });
      return namespace;
    }
    return get(c, "SELECT session_group FROM conversations WHERE channel=? AND endpoint_id IS ? AND direction='in' AND session_group<>'' ORDER BY id DESC LIMIT 1", channel, endpointId)?.session_group ?? namespace;
  }
  function insert(c, direction, channel, endpointId, content, group, options = {}) {
    const result = run(c, `INSERT INTO conversations(direction,channel,endpoint_id,content,status,delivery_action,priority,require_idle,session_group,session_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, direction, channel, endpointId ?? null, content, options.status ?? (direction === 'in' ? 'pending' : 'delivered'), options.deliveryAction ?? null, options.priority ?? 3, options.requireIdle ? 1 : 0, group, direction === 'out' ? options.sessionId ?? null : null);
    const id = Number(result.lastInsertRowid);
    run(c, 'INSERT INTO group_heads(session_group,head_id) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET head_id=max(head_id,excluded.head_id)', group, id);
    return get(c, 'SELECT * FROM conversations WHERE id=?', id);
  }
  const api = {
    getChannelNamespace: name => read(c => binding(c, name)),
    getComponentByNamespace: namespace => read(c => get(c, 'SELECT component_name FROM channel_namespaces WHERE namespace=?', namespace)?.component_name ?? null),
    ensureChannelNamespace: name => write(c => ensure(c, name)),
    registerChannelNamespace: (name, namespace) => write(c => {
      installed(name);
      if (!validNamespace(namespace)) throw dataError('NAMESPACE_INVALID', 'Invalid namespace');
      const old = binding(c, name);
      if (old?.namespace === namespace) return old;
      if (old || get(c, 'SELECT 1 FROM channel_namespaces WHERE namespace=?', namespace)) throw dataError('NAMESPACE_CONFLICT', 'Namespace or component is already bound');
      run(c, 'INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)', namespace, name);
      return { componentName: name, namespace };
    }),
    resolveSessionGroup: (direction, channel, endpointId, options) => write(c => resolve(c, direction, channel, endpointId, options)),
    insertConversation: (direction, channel, endpointId, content, options = {}) => write(c => {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw dataError('INVALID_ARGS', 'Expected message options');
      if (typeof content !== 'string') throw dataError('INVALID_ARGS', 'Message content must be a string');
      const allowed = new Set(['status', 'priority', 'requireIdle', 'deliveryAction', 'groupName', 'handoffGroup', 'sessionId']);
      if (Object.keys(options).some(key => !allowed.has(key))) throw dataError('INVALID_ARGS', 'Unknown message option');
      if (options.status !== undefined && !(direction === 'in' ? ['pending', 'failed'] : ['delivered']).includes(options.status)) throw dataError('INVALID_ARGS', 'Invalid initial message status');
      return insert(c, direction, channel, endpointId, content, resolve(c, direction, channel, endpointId, options), options);
    }),
    insertInternalMessage: (senderGroup, targetGroup, content, { sessionId } = {}) => write(c => {
      if (!senderGroup) throw dataError('NO_SENDER_GROUP', 'Sender session group is required');
      if (!parseSessionGroup(senderGroup) || !exists(c, senderGroup)) throw dataError('UNKNOWN_SENDER_GROUP', 'Unknown sender session group');
      if (!parseSessionGroup(targetGroup) || !exists(c, targetGroup)) throw dataError('UNKNOWN_TARGET_GROUP', 'Unknown target session group');
      if (senderGroup === targetGroup) throw dataError('SELF_TARGET', 'Cannot send to the sender session group');
      if (typeof content !== 'string' || !content.trim()) throw dataError('EMPTY_CONTENT', 'Message content is empty');
      const outRow = insert(c, 'out', 'internal', targetGroup, content, senderGroup, { sessionId });
      const inRow = insert(c, 'in', 'internal', senderGroup, `[internal] ${senderGroup} said: ${content}`, targetGroup);
      return { outRow, inRow };
    }),
  };
  const context = { read, write, snapshot, get, all, run, knownGroup, dependencies, seconds };
  const config = configFunctions(context);
  const progress = progressFunctions(context);
  const transitions = transitionFunctions({ ...context, ...progress });
  Object.assign(api, deliveryFunctions(context), config.api, progress.api, controlFunctions({ ...context, baseline: config.baseline }), transitions.api);
  api.buildTargetBinding = createTargetBindingBuilder({ ...context, baseline: config.baseline, resolveTarget: dependencies.resolveTarget });
  function listGroups({ match, limit } = {}) {
    if (match !== undefined && typeof match !== 'string') throw dataError('INVALID_ARGS', 'match must be a string');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw dataError('INVALID_ARGS', 'limit must be positive');
    return snapshot(c => {
      const result = [];
      for (const head of all(c, 'SELECT h.session_group,c.timestamp FROM group_heads h JOIN conversations c ON c.id=h.head_id ORDER BY h.head_id DESC')) {
        const preview = get(c, "SELECT timestamp,channel,endpoint_id,content FROM conversations WHERE session_group=? AND direction='in' AND channel<>'internal' ORDER BY id DESC LIMIT 1", head.session_group);
        const text = preview ? [...preview.content].slice(0, 80).join('') : null;
        if (match !== undefined && !head.session_group.toLowerCase().includes(match.toLowerCase()) && !(text ?? '').toLowerCase().includes(match.toLowerCase())) continue;
        const parsed = parseSessionGroup(head.session_group);
        const componentName = parsed && parsed.namespace !== 'origin' ? get(c, 'SELECT component_name FROM channel_namespaces WHERE namespace=?', parsed.namespace)?.component_name ?? null : null;
        const millis = value => Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
        result.push({ sessionGroup: head.session_group, componentName, sessionGroupName: parsed?.groupName ?? null, lastActivityAt: millis(head.timestamp), preview: preview ? { timestamp: millis(preview.timestamp), channel: preview.channel, endpoint: preview.endpoint_id, text } : null });
        if (result.length === limit) break;
      }
      return result;
    });
  }
  Object.defineProperty(api, 'queries', { value: { originSummaries: progress.originSummaries, originCombined: progress.originCombined, readAbsorbed: transitions.readAbsorbed, unsummarized: progress.unsummarizedQuery, listGroups } });
  return api;
}
