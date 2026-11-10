import { isIP } from 'node:net';

export function sessionCookiePath(prefix) {
  if (typeof prefix !== 'string' || prefix.length > 64
      || !prefix.startsWith('/') || /[^A-Za-z0-9/_-]/.test(prefix) || prefix.includes('//')) return '/';
  return prefix;
}

export function isLocalHttpsProxy(req) {
  const address = req.socket?.remoteAddress;
  const ipv4 = typeof address === 'string' && address.startsWith('::ffff:')
    ? address.slice(7) : address;
  const loopback = address === '::1' || (isIP(ipv4 || '') === 4 && ipv4.startsWith('127.'));
  return loopback && req.headers['x-forwarded-proto'] === 'https';
}

export function appendSetCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', current === undefined ? [cookie]
    : [...(Array.isArray(current) ? current : [current]), cookie]);
}

function cookie(req, token, cookiePath, maxAge) {
  const secure = isLocalHttpsProxy(req) ? '; Secure' : '';
  const lifetime = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  return `wc_session=${token}; Path=${cookiePath}; HttpOnly; SameSite=Strict${secure}${lifetime}`;
}

export function setSessionCookie(req, res, token, { remember, maxAgeSec }) {
  const cookiePath = sessionCookiePath(req.headers['x-forwarded-prefix']);
  // Clear the old root cookie separately so browsers keep only the scoped token.
  if (cookiePath !== '/') appendSetCookie(res, cookie(req, '', '/', 0));
  appendSetCookie(res, cookie(req, token, cookiePath, remember !== false ? maxAgeSec : undefined));
}

export function clearSessionCookie(req, res) {
  const cookiePath = sessionCookiePath(req.headers['x-forwarded-prefix']);
  appendSetCookie(res, cookie(req, '', cookiePath, 0));
}
