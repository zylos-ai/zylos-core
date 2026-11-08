/** Why the observer needs recovery before it can be used again, or null when it does not. */
export function observerRecoveryReason(status) {
  return (status?.runtime?.state === 'blocked' ? status.runtime.error || 'teardown_failed' : null) || status?.startupError || status?.desired?.lastError || status?.desired?.removalState ||
    (status?.desired?.enabled && status?.desired?.teardownFence ? 'teardown_fenced' : null);
}

/**
 * Whether the observer page may show the live view: the observer is installed, enabled and healthy, and either
 * this machine is being viewed or the remote machine was reached with an admin key. The page passes what it knows
 * (`viewingRemote`, `access` as 'admin' or 'read'); when it says nothing, the view counts as remote and read-only.
 */
export function observerPageUsable(status, { viewingRemote = true, access = 'read' } = {}) {
  const mayControl = viewingRemote === false || access === 'admin';
  return status?.state === 'installed' && status.desired?.enabled === true && !observerRecoveryReason(status) && mayControl;
}
