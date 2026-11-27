const DEFAULT_PALETTE = [
  '#0d9488',
  '#2563eb',
  '#dc2626',
  '#7c3aed',
  '#ea580c',
  '#059669',
  '#db2777',
  '#4f46e5',
  '#0891b2',
  '#65a30d'
];

export function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const ch of String(value || '')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function agentColor(name, palette = DEFAULT_PALETTE) {
  const colors = Array.isArray(palette) && palette.length > 0 ? palette : DEFAULT_PALETTE;
  const hash = fnv1a32(String(name || '').toLowerCase());
  return {
    hash,
    color: colors[hash % colors.length],
    hue: hash % 360
  };
}

