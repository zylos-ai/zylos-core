// Accept browser provenance without inferring the public protocol from proxies.
// Callers apply this only to cookie-authenticated requests that need CSRF checks.
export function isSameOriginRequest(req) {
  const headers = req.headers || {};
  if (Object.hasOwn(headers, 'sec-fetch-site')) {
    const site = headers['sec-fetch-site'];
    // This is a single browser token, not a comma-separated proxy chain.
    return typeof site === 'string' && site.trim().toLowerCase() === 'same-origin';
  }

  const origin = headers.origin;
  const firstHost = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (typeof origin !== 'string' || typeof firstHost !== 'string') return false;
  const host = firstHost.split(',')[0].trim().toLowerCase();
  // Check authority syntax before URL parsing can discard userinfo or a path.
  // URL parsing below also validates IPv6 and the numeric port range.
  if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]+)?$/.test(host)) return false;
  try {
    const originUrl = new URL(origin);
    if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.origin !== origin) return false;
    // Only the Origin scheme determines which port is the default. In
    // particular, HTTPS :80 and HTTP :443 must retain their distinct ports.
    return originUrl.host === new URL(`${originUrl.protocol}//${host}`).host;
  } catch {
    return false;
  }
}
