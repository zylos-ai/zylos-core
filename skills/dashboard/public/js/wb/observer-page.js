/** Why the observer needs recovery before it can be used again, or null when it does not. */
export function observerRecoveryReason(status) {
  return (status?.runtime?.state === 'blocked' ? status.runtime.error || 'teardown_failed' : null) || status?.startupError || status?.desired?.lastError || status?.desired?.removalState ||
    (status?.desired?.enabled && status?.desired?.teardownFence ? 'teardown_fenced' : null);
}

/**
 * The machine the page is viewing: `viewingRemote` when another machine is viewed (chosen in the page, or the page
 * itself was opened through another machine's address), and the access its key has, 'admin' or 'read'. A remote
 * machine counts as read-only unless its key is known to be an admin key; this machine is always 'admin'.
 */
export function viewedAccess({ remoteAgent = null, fleetAgents = [], pageRemoteAgent = null, pageRemoteAccess = 'read' } = {}) {
  if (remoteAgent) return { viewingRemote: true, access: fleetAgents.find(agent => agent.name === remoteAgent)?.access === 'admin' ? 'admin' : 'read' };
  if (pageRemoteAgent) return { viewingRemote: true, access: pageRemoteAccess === 'admin' ? 'admin' : 'read' };
  return { viewingRemote: false, access: 'admin' };
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

/** Running targets from the same workbench snapshot used to select groups. */
export function runningObserverGroups(snapshot) {
  return (snapshot?.rows ?? []).filter(row => row.presence === 'running' && Boolean(row.live?.runId));
}

export function observerGroupRow(snapshot, sessionGroup) {
  if (sessionGroup === undefined) return null;
  return snapshot?.rows?.find(row => (row.sessionGroup ?? 'origin') === (sessionGroup ?? 'origin')) ?? null;
}

export function observerGroupName(row, sessionGroup, originName) {
  return row?.name?.displayName || ((sessionGroup ?? 'origin') === 'origin' ? originName : sessionGroup);
}

/** Retire the previous viewer before applying a group choice, including an in-flight lease. */
export async function switchObserverTarget(observer, { identity, disconnect, apply }) {
  const generation = ++observer.selectionGeneration;
  const machine = identity();
  await disconnect();
  if (generation !== observer.selectionGeneration || machine !== identity()) return false;
  apply();
  return true;
}
