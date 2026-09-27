/**
 * wc_session cookie scoping.
 *
 * Behind Caddy, Web Console is mounted under a prefix (normally /console) and
 * Caddy forwards it as X-Forwarded-Prefix. The session cookie is scoped to that
 * prefix so browsers stop sending it to other components on the same host.
 * Without a valid prefix (direct access, or a Caddyfile that has not been
 * migrated) the cookie keeps Path=/, so nobody is locked out.
 *
 * Each session token records the path its cookie was issued for
 * (`<hex>:<path>`; a bare `<hex>` token means `/`, which covers sessions
 * created before scoping existed). A token presented on a request whose cookie
 * path differs is retired: this is how a browser still holding the old
 * Path=/ cookie gets it cleared once the prefix header is in place.
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'wc_session';
const ROOT_PATH = '/';
const PREFIX_RE = /^\/[A-Za-z0-9_/-]{0,63}$/;

function firstHeader(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : '';
  return typeof value === 'string' ? value.trim() : '';
}

/** Cookie Path for this request: the validated forwarded prefix, else `/`. */
export function cookiePathFromRequest(req) {
  const prefix = firstHeader(req.headers['x-forwarded-prefix']);
  if (!PREFIX_RE.test(prefix) || prefix.includes('//')) return ROOT_PATH;
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed || ROOT_PATH;
}

/**
 * True when the browser reached us over HTTPS. The page's own scheme (Origin,
 * sent by the browser on the login/logout POSTs) is trusted over the forwarded
 * protocol, which a TLS-terminating proxy in front of Caddy may rewrite to
 * http. Either only ever adds `Secure`, never removes it.
 */
export function isSecureRequest(req) {
  const origin = firstHeader(req.headers.origin);
  if (origin.startsWith('https://')) return true;
  const proto = firstHeader(req.headers['x-forwarded-proto']).split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** All wc_session values in the Cookie header, in the order the browser sent them. */
export function readSessionTokens(cookieHeader) {
  const tokens = [];
  if (!cookieHeader) return tokens;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      if (value) tokens.push(value);
    }
  }
  return tokens;
}

export function createSessionToken(cookiePath) {
  const hex = crypto.randomBytes(32).toString('hex');
  return cookiePath === ROOT_PATH ? hex : `${hex}:${cookiePath}`;
}

export function sessionTokenPath(token) {
  const idx = token.indexOf(':');
  if (idx === -1) return ROOT_PATH;
  const tokenPath = token.slice(idx + 1);
  return PREFIX_RE.test(tokenPath) ? tokenPath : null;
}

function attributes(cookiePath, secure) {
  return `Path=${cookiePath}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function sessionCookie(token, cookiePath, { secure = false, maxAgeSec = null } = {}) {
  const maxAge = maxAgeSec == null ? '' : `; Max-Age=${maxAgeSec}`;
  return `${SESSION_COOKIE}=${token}; ${attributes(cookiePath, secure)}${maxAge}`;
}

export function clearSessionCookie(cookiePath, { secure = false } = {}) {
  return `${SESSION_COOKIE}=; ${attributes(cookiePath, secure)}; Max-Age=0`;
}

/**
 * Split the presented tokens into the session to use and the cookies to retire.
 * `isValid(token)` checks the session store.
 *
 * @returns {{ token: string|null, retire: Array<{ token: string, path: string|null }> }}
 */
export function resolveSessionTokens(tokens, cookiePath, isValid) {
  let token = null;
  const retire = [];
  for (const candidate of tokens) {
    const tokenPath = sessionTokenPath(candidate);
    if (tokenPath !== cookiePath) {
      retire.push({ token: candidate, path: tokenPath });
    } else if (!token && isValid(candidate)) {
      token = candidate;
    }
  }
  return { token, retire };
}

/** Append Set-Cookie values without overwriting ones already set on the response. */
export function appendSetCookie(res, cookies) {
  const existing = res.getHeader('Set-Cookie');
  const values = existing === undefined ? [] : [].concat(existing);
  res.setHeader('Set-Cookie', [...values, ...cookies]);
}
