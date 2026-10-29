export function epochToIso(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const millis = number > 100000000000 ? number : number * 1000;
  return new Date(millis).toISOString();
}

export function ageSeconds(iso) {
  if (!iso) return null;
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis)) return null;
  return Math.max(0, Math.round((Date.now() - millis) / 1000));
}

export function isStale(iso, maxAgeSeconds) {
  const age = ageSeconds(iso);
  return age == null ? false : age > maxAgeSeconds;
}

export function nowIso() {
  return new Date().toISOString();
}
