import { dataError, requireGroup } from './c4-session-group.js';
import { formatAbsorbedPage, formatAbsorbedPart, formatAbsorbedSummary, formatQueryError } from './c4-query-format.js';

const invalid = message => { throw dataError('INVALID_ARGS', message); };
const integer = (value, name, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${name} must be an integer >= ${minimum}`);
  return value;
};
const groupScope = group => group === undefined ? '*' : requireGroup(group);

// Pure adapters: no process, file, stdout or default database access. The later
// CLI integration owns argv routing and the existing legacy text presentation.
export function createQueryHandlers(store) {
  return {
    absorbed(options = {}) {
      const { runId, summary = false, id, group, scopeAfter, after, limit, field, offset, maxBytes } = options;
      if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) invalid('runId must be a UUID');
      if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 2048 || maxBytes > 16384)) invalid('maxBytes must be between 2048 and 16384');
      if (summary && (id !== undefined || group !== undefined || after !== undefined || limit !== undefined || field !== undefined || offset !== undefined)) invalid('Summary options cannot be mixed with page or part options');
      if (!summary && scopeAfter !== undefined) invalid('scopeAfter requires summary');
      if (scopeAfter !== undefined && scopeAfter !== '*') requireGroup(scopeAfter);
      if (id !== undefined) {
        integer(id, 'id', 1);
        if (group !== undefined || after !== undefined || limit !== undefined) invalid('Part options cannot be mixed with page options');
      } else if (field !== undefined || offset !== undefined) invalid('field and offset require id');
      if (group !== undefined && group !== '*') requireGroup(group);
      if (after !== undefined) integer(after, 'after');
      if (limit !== undefined) integer(limit, 'limit', 1);
      const snapshot = store.queries.readAbsorbed(runId);
      return summary ? formatAbsorbedSummary(snapshot, options) : id !== undefined ? formatAbsorbedPart(snapshot, options) : formatAbsorbedPage(snapshot, options);
    },
    modeTransition({ runId } = {}) {
      const row = store.getModeTransition({ runId });
      if (runId !== undefined && !row) throw dataError('RUN_NOT_FOUND', 'Mode transition does not exist');
      return row;
    },
    groups(options = {}) { return store.queries.listGroups(options); },
    unsummarizedRange({ group } = {}) {
      return groupScope(group) === '*' ? store.getGlobalUnsummarizedRange() : store.getUnsummarizedRange(group);
    },
    unsummarized({ group, upToConversationId, limit } = {}) {
      return store.queries.unsummarized({ group: groupScope(group), upToConversationId, limit });
    },
    checkpoints({ group, after } = {}) {
      integer(after, 'after');
      return store.getContentCheckpointsSince(groupScope(group), after);
    },
    originBacklog() { return store.getOriginSyncBacklog(); },
    originSummaries({ group } = {}) {
      requireGroup(group);
      return store.queries.originSummaries(group);
    },
    originCombined({ group, limit } = {}) {
      requireGroup(group);
      if (limit !== undefined) integer(limit, 'limit', 1);
      return store.queries.originCombined(group, { limit });
    },
    originRaw({ group, after, limit } = {}) {
      requireGroup(group); integer(after, 'after');
      if (limit !== undefined) integer(limit, 'limit', 1);
      const cursor = store.getOriginSyncBacklog().groups.find(item => item.sessionGroup === group);
      if (!cursor) return [];
      return store.getOriginSyncConversations(group, {
        afterConversationId: cursor.cursorFrom, rawAfter: after,
        upToConversationId: cursor.upTo, limit: limit ?? Number.MAX_SAFE_INTEGER,
      });
    },
  };
}

// Buffer the complete result before the caller performs a single write. This
// keeps integrity failures from being appended to an already emitted page.
export function runAbsorbedQuery(store, options = {}) {
  try { return { exitCode: 0, stdout: createQueryHandlers(store).absorbed(options), stderr: '' }; }
  catch (error) {
    const encoded = formatQueryError(error, options);
    return { exitCode: 1, stdout: options.json ? encoded : '', stderr: options.json ? '' : encoded };
  }
}
