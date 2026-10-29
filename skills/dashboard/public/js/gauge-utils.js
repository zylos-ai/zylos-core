// Input is always a 0-100 percentage. Never infer fractions here: a genuine
// 0.5% reading must render as "1%", not "50%" (#251).
export function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${Math.round(Math.max(0, Math.min(100, n)))}%`;
}

export function resolveCpuDisplay(rawVal, lastGood) {
  const n = Number(rawVal);
  if (Number.isFinite(n)) return { display: pct(n), lastGood: n };
  if (lastGood !== null && lastGood !== undefined) return { display: pct(lastGood), lastGood };
  return { display: '--', lastGood: null };
}
