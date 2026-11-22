import { listFailure, parseListQuery } from '../list-query.js';

export const levels = ['plain', 'technical'];

export function timelineQuery(collection, search, filters) {
  const query = parseListQuery(collection, search, { filters, extras: { direction: ['before', 'after'] } });
  const before = query.extras.direction !== 'after';
  if (!before && query.after === null) throw listFailure(400, 'invalid_cursor', 'A cursor is required to read newer rows');
  return { ...query, before, operator: before ? '<' : '>', order: before ? 'DESC' : 'ASC' };
}

export function timelinePage(rows, query, key, initial) {
  const page = rows.slice(0, query.limit);
  const boundary = page.at(-1);
  const newest = query.before ? page[0] : boundary;
  return {
    items: query.before ? page.reverse() : page,
    nextCursor: query.before && rows.length > query.limit ? query.nextCursor(key(boundary)) : null,
    afterCursor: query.nextCursor(newest ? key(newest) : query.after ?? initial),
  };
}
