export function hasStatusChanged(current, previous) {
  if (!previous) return true;
  return current?.state !== previous?.state ||
    current?.health !== previous?.health ||
    current?.unavailable_reason !== previous?.unavailable_reason ||
    current?.cooldown_until !== previous?.cooldown_until;
}
