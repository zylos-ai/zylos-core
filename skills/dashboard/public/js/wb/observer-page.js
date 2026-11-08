/** Why the observer needs recovery before it can be used again, or null when it does not. */
export function observerRecoveryReason(status) {
  return (status?.runtime?.state === 'blocked' ? status.runtime.error || 'teardown_failed' : null) || status?.startupError || status?.desired?.lastError || status?.desired?.removalState ||
    (status?.desired?.enabled && status?.desired?.teardownFence ? 'teardown_fenced' : null);
}

/**
 * Whether the observer page may show the live view: the observer is installed, enabled and healthy,
 * and the machine being viewed was reached with a key that may control it. Read-only unless told otherwise.
 */
export function observerPageUsable(status, { readOnly = true } = {}) {
  return status?.state === 'installed' && status.desired?.enabled === true && !observerRecoveryReason(status) && readOnly === false;
}
