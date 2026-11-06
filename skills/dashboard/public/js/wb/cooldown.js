// Core clears cooldownUntil to 0 when a reply is due, so only a future epoch
// second is a recovery time. Anything else is an unknown recovery time.
export function recoveryTime(cooldownUntil, now = Date.now()) {
  if (typeof cooldownUntil !== 'number' || !Number.isFinite(cooldownUntil) || cooldownUntil <= 0) return null;
  const at = cooldownUntil * 1000;
  return at > now ? at : null;
}
