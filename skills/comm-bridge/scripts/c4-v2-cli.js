import fs from 'node:fs';
import { dataError, requireGroup } from './c4-session-group.js';
import { formatAbsorbedPage, formatAbsorbedFull, formatAbsorbedSummary, formatQueryError, absorbedField } from './c4-query-format.js';

const invalid = message => { throw dataError('INVALID_ARGS', message); };
const integer = (value, name, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${name} must be an integer >= ${minimum}`);
  return value;
};
const groupScope = group => group === undefined ? '*' : requireGroup(group);

// Query adapters buffer output before emitting. Only explicit full-field export
// writes a file; database access remains through the supplied store.
export function createQueryHandlers(store) {
  return {
    absorbed(options = {}) {
      const { runId, summary = false, id, group, scopeAfter, after, limit, field, out } = options;
      if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) invalid('runId must be a UUID');
      const allowed = ['runId', 'summary', 'id', 'group', 'scopeAfter', 'after', 'limit', 'field', 'out', 'json'];
      if (Object.keys(options).some(key => !allowed.includes(key))) invalid('Unexpected absorbed query argument');
      if (summary && (id !== undefined || group !== undefined || after !== undefined || field !== undefined || out !== undefined)) invalid('Summary options cannot be mixed with page or full options');
      if (!summary && scopeAfter !== undefined) invalid('scopeAfter requires summary');
      if (scopeAfter !== undefined && scopeAfter !== '*') requireGroup(scopeAfter);
      if (id !== undefined) {
        integer(id, 'id', 1);
        if (group !== undefined || after !== undefined || limit !== undefined) invalid('Full options cannot be mixed with page options');
      } else if (field !== undefined || out !== undefined) invalid('field and out require id');
      if (out !== undefined && (typeof out !== 'string' || !out || out.includes('\0'))) invalid('Invalid output path');
      if (group !== undefined && group !== '*') requireGroup(group);
      if (after !== undefined) integer(after, 'after');
      if (limit !== undefined) integer(limit, 'limit', 1);
      const snapshot = store.queries.readAbsorbed(runId);
      // Validate and encode before creating the destination; integrity errors
      // must never publish a partial export.
      if (out !== undefined) {
        const value = absorbedField(snapshot, options).data;
        const output = formatAbsorbedFull(snapshot, options);
        let descriptor;
        try { descriptor = fs.openSync(out, 'wx', 0o600); }
        catch (cause) { throw dataError(cause.code === 'EEXIST' ? 'INVALID_ARGS' : 'WRITE_FAILED', 'Could not create output file', { cause }); }
        try { fs.writeFileSync(descriptor, value, 'utf8'); fs.closeSync(descriptor); }
        catch (cause) {
          try { fs.closeSync(descriptor); } catch {}
          try { fs.unlinkSync(out); } catch {}
          throw dataError('WRITE_FAILED', 'Could not write output file', { cause });
        }
        return output;
      }
      return summary ? formatAbsorbedSummary(snapshot, options) : id !== undefined ? formatAbsorbedFull(snapshot, options) : formatAbsorbedPage(snapshot, options);
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
