export function normalizeVersion(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/(\d+(?:\.\d+){0,3})(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[1] : null;
}

export function compareVersions(a, b) {
  const va = normalizeVersion(a);
  const vb = normalizeVersion(b);
  if (!va || !vb) return null;
  const pa = va.split('.').map(Number);
  const pb = vb.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const left = pa[i] || 0;
    const right = pb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}
