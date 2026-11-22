import { listFailure, parseListQuery } from './list-query.js';

/** A key as the API shows it: metadata only, never key material or its hash. */
export function apiKeyPayload(key) {
  return {
    name: key.name,
    scope: key.scope,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    revoked_at: key.revoked_at,
    status: key.revoked_at ? 'revoked' : 'active'
  };
}

const keyCursor = position => Array.isArray(position) && position.length === 3 && (position[0] === 0 || position[0] === 1)
  && typeof position[1] === 'string' && Number.isSafeInteger(position[2]);

/**
 * GET /api/keys under the list API standard: active keys before revoked ones, then created_at DESC, id DESC; `q`
 * matches the key name. `counts` covers every key whatever the search, for the card header.
 */
export function apiKeysPage(store, searchParams) {
  const query = parseListQuery('keys', searchParams, { q: true, include: ['total'] });
  if (query.after !== null && !keyCursor(query.after)) throw listFailure(400, 'invalid_cursor', 'The cursor is no longer valid; reload the first page');
  let rows, counts;
  try {
    rows = store.listApiKeysPage({ after: query.after, limit: query.limit + 1, q: query.q });
    counts = store.countApiKeys(query.q);
  } catch {
    throw listFailure(503, 'unavailable', 'The key list cannot be read');
  }
  const page = rows.slice(0, query.limit), last = page.at(-1);
  return {
    items: page.map(apiKeyPayload),
    nextCursor: rows.length > query.limit ? query.nextCursor([last.revoked, last.created_at, last.id]) : null,
    ...(query.include.has('total') ? { total: counts.matched } : {}),
    counts: { active: counts.active, revoked: counts.revoked },
  };
}
