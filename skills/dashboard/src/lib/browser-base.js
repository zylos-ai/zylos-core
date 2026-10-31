function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim();
}

function isSafePathPrefix(prefix) {
  if (!prefix || prefix === '/') return true;
  if (!prefix.startsWith('/')) return false;
  if (prefix.includes('\\') || prefix.includes('://') || prefix.includes('//')) return false;
  if (/[\x00-\x20?#"'`<>&%]/.test(prefix)) return false;
  const parts = prefix.split('/');
  return parts.every(part => part !== '.' && part !== '..');
}

export function browserBaseFromRequest(req) {
  const prefix = firstHeaderValue(req.headers['x-forwarded-prefix']);
  if (!prefix || !isSafePathPrefix(prefix)) return '';
  if (prefix === '/') return '';
  return prefix.replace(/\/+$/, '');
}

export function browserRoot(base = '') {
  return base ? `${base}/` : '/';
}

export function browserPath(base = '', path = '') {
  const cleanPath = String(path).replace(/^\/+/, '');
  return base ? `${base}/${cleanPath}` : `/${cleanPath}`;
}

export function isPathWithinBase(path, base = '') {
  if (!path || typeof path !== 'string') return false;
  if (path.startsWith('//') || path.includes('://') || path.includes('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path) || /[\x00-\x1f]/.test(path)) return false;
  try {
    const parsed = new URL(path, 'https://zylos.local/');
    if (parsed.origin !== 'https://zylos.local' || parsed.username || parsed.password) return false;
    if (parsed.pathname.split('/').some(part => part === '.' || part === '..')) return false;
    if (!base) return true;
    return parsed.pathname === base || parsed.pathname.startsWith(`${base}/`);
  } catch {
    return false;
  }
}
