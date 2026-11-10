import { fallbackName } from './plain-text.js?v=106';

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

export function observerGroupName(row, sessionGroup, originName, t = key => key) {
  return row?.name?.displayName || ((sessionGroup ?? 'origin') === 'origin' ? originName : fallbackName(row ?? { sessionGroup }, t));
}

/** A producer without mode metadata has only the legacy Origin target. */
export function observerLeaseTarget(status, sessionGroup) {
  if (!status || typeof status !== 'object') return { supported: false, sessionGroup: undefined };
  if (!Object.hasOwn(status, 'sessionMode')) {
    return { supported: sessionGroup == null || sessionGroup === 'origin', sessionGroup: undefined };
  }
  if (status.sessionMode === 'multi') return { supported: true, sessionGroup: sessionGroup ?? 'origin' };
  if (status.sessionMode === 'single') return { supported: true, sessionGroup: null };
  return { supported: false, sessionGroup: undefined };
}

/** Modern bindings are exact; only the legacy Origin protocol omits the field. */
export function observerLeaseMatches(status, sessionGroup, lease) {
  const target = observerLeaseTarget(status, sessionGroup);
  if (!target.supported || !lease || typeof lease !== 'object') return false;
  return target.sessionGroup === undefined ? !Object.hasOwn(lease, 'sessionGroup') : lease.sessionGroup === target.sessionGroup;
}

export function observerFrameVisible({ historyMode, choosing, idle, lease, noticeState } = {}) {
  return !historyMode && !choosing && !idle && (Boolean(lease) || noticeState !== 'error');
}

/** Page title key: while the group picker is on screen it names the group, so the title is just the page name. */
export function observerTitleKey({ focus, hasTarget, multi } = {}) {
  if (focus && hasTarget) return 'wb.observer.focusTitle';
  return multi && !focus ? 'observer.title' : 'wb.observer.pageTitle';
}

/**
 * The status row speaks about the live connection, so the history view hides it. Before a group is chosen the
 * picker says what to do; the row only speaks then when there is nothing to pick.
 */
export function observerNoticeHidden({ historyMode, choosing, runningCount } = {}) {
  return Boolean(historyMode) || (Boolean(choosing) && runningCount > 0);
}

/** Text after the folded size button ("Size 120×40"); empty when the size form is not offered. */
export function observerSizeLabel(agentSize, offered) {
  return offered && agentSize ? ` ${agentSize.cols}×${agentSize.rows}` : '';
}

/** A terminal wider than its box scrolls sideways, and the page says so under it. */
export function observerFrameWide(frameWidth, boxWidth) {
  return Math.ceil(frameWidth) > boxWidth;
}

/** Fence local viewer state before applying a group choice; network release may finish later. */
export async function switchObserverTarget(observer, { identity, disconnect, apply }) {
  const generation = ++observer.selectionGeneration;
  const machine = identity();
  await disconnect();
  if (generation !== observer.selectionGeneration || machine !== identity()) return false;
  apply();
  return true;
}
