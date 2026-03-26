export function getInitialUsageCheckAt({ runtimeId, usageState, nowEpoch }) {
  if (runtimeId === 'codex') return 0;

  if (usageState?.lastCheckEpoch) return usageState.lastCheckEpoch;

  // Fresh Claude installs should still wait a full interval before the first
  // /usage probe. Codex uses rollout-backed reads, so restarts should refresh
  // usage state immediately instead of waiting for the old persisted timestamp.

  return nowEpoch;
}
