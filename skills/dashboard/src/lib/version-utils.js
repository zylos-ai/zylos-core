export function normalizeVersion(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/(\d+(?:\.\d+){0,3})(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[1] : null;
}

const RELEASE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function comparePrereleases(left, right) {
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const numericA = /^\d+$/.test(a[i]);
    const numericB = /^\d+$/.test(b[i]);
    if (numericA && numericB) return Math.sign(a[i].length - b[i].length) || (a[i] > b[i] ? 1 : -1);
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a[i] > b[i] ? 1 : -1;
  }
  return Math.sign(a.length - b.length);
}

export function compareVersions(a, b, { prerelease = false } = {}) {
  const releaseA = prerelease && typeof a === 'string' ? a.trim().match(RELEASE_VERSION) : null;
  const releaseB = prerelease && typeof b === 'string' ? b.trim().match(RELEASE_VERSION) : null;
  if (prerelease && (!releaseA || !releaseB || [releaseA[4], releaseB[4]].some(value => /(?:^|\.)0\d+(?:\.|$)/.test(value ?? '')))) return null;
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
  return prerelease ? comparePrereleases(releaseA[4], releaseB[4]) : 0;
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}
