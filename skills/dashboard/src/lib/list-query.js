import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// One key per process: a Dashboard restart invalidates every outstanding cursor,
// and clients reload the first page (list API standard rule 4.3).
const CURSOR_KEY = randomBytes(32);
const MAX_CURSOR_LENGTH = 1024;
const MAX_Q_LENGTH = 64;

/** A boolean filter accepts exactly `true` or `false`. */
export const BOOLEAN = Symbol('boolean');

/** A failure with a standard list code; `param` names the rejected query parameter. */
export function listFailure(status, code, message, param) {
  return Object.assign(new Error(message), { statusCode: status, code, ...(param ? { param } : {}) });
}

/** The common error envelope for a list failure, keeping `error.param`. */
export function listErrorBody(error) {
  return { ok: false, error: { code: error.code, message: error.message, ...(error.param ? { param: error.param } : {}) } };
}

const invalid = (param, message) => listFailure(400, 'invalid_parameter', message, param);
const invalidCursor = () => listFailure(400, 'invalid_cursor', 'The cursor is no longer valid; reload the first page');

function parseFilter(name, value, rule) {
  if (rule === BOOLEAN) {
    if (value === 'true' || value === 'false') return value === 'true';
    throw invalid(name, `${name} must be true or false`);
  }
  if (Array.isArray(rule)) {
    if (rule.includes(value)) return value;
    throw invalid(name, `${name} must be one of ${rule.join(', ')}`);
  }
  const parsed = rule(value);
  if (parsed === undefined) throw invalid(name, `Invalid ${name}`);
  return parsed;
}

function sign(body) {
  return createHmac('sha256', CURSOR_KEY).update(body).digest();
}

/**
 * Parses a collection query under the list API standard.
 *
 * `filters` maps each filter parameter to an array of allowed values, BOOLEAN, or a parser that returns the
 * parsed value or undefined when invalid. `extras` takes the same rules for parameters that are validated but not
 * bound to the cursor: paging parameters such as `direction` or an anchor, and per-request ID lists. `include` lists the optional parts the route can add. `paging: false`
 * is for detail routes, which accept no `limit` or `cursor`. Any other parameter, or a repeated one, is rejected.
 *
 * The result's `after` is the position decoded from `cursor` (null on the first page). `nextCursor(position)`
 * signs the last row's sort key and ID; the cursor is valid only for the same collection, filters and `q`.
 */
export function parseListQuery(collection, params, { filters = {}, extras = {}, q = false, include = [], paging = true } = {}) {
  const allowed = new Set([...Object.keys(filters), ...Object.keys(extras), ...(q ? ['q'] : []), ...(include.length ? ['include'] : []),
    ...(paging ? ['limit', 'cursor'] : [])]);
  for (const name of new Set(params.keys())) {
    if (!allowed.has(name)) throw invalid(name, `Unknown parameter ${name}`);
    if (params.getAll(name).length !== 1) throw invalid(name, `Parameter ${name} must be given once`);
  }

  const query = { filters: {}, extras: {}, q: null, include: new Set(), limit: null, after: null };
  for (const [name, rule] of Object.entries(filters)) {
    if (params.has(name)) query.filters[name] = parseFilter(name, params.get(name), rule);
  }
  for (const [name, rule] of Object.entries(extras)) {
    if (params.has(name)) query.extras[name] = parseFilter(name, params.get(name), rule);
  }
  if (params.has('q')) {
    const text = params.get('q').trim();
    if (text.length > MAX_Q_LENGTH) throw invalid('q', `q must contain at most ${MAX_Q_LENGTH} characters`);
    query.q = text || null;
  }
  if (params.has('include')) {
    for (const part of params.get('include').split(',')) {
      if (!include.includes(part) || query.include.has(part)) throw invalid('include', `include must list ${include.join(', ')} at most once each`);
      query.include.add(part);
    }
  }
  if (!paging) return query;

  const limitText = params.get('limit') ?? '50';
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) throw invalid('limit', 'limit must be an integer from 1 to 100');
  query.limit = Number(limitText);

  const scope = JSON.stringify([collection, Object.keys(query.filters).sort().map(name => [name, query.filters[name]]), query.q]);
  if (params.has('cursor')) query.after = readCursor(params.get('cursor'), scope);
  query.nextCursor = position => {
    const body = Buffer.from(JSON.stringify({ scope, position })).toString('base64url');
    return `${body}.${sign(body).toString('base64url')}`;
  };
  return query;
}

function readCursor(token, scope) {
  if (token.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  const [body, signature, extra] = token.split('.');
  const actual = Buffer.from(signature ?? '', 'base64url');
  const expected = sign(body);
  if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidCursor();
  let decoded;
  try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
  if (decoded?.scope !== scope || decoded.position === undefined) throw invalidCursor();
  return decoded.position;
}
