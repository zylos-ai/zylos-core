export function getInitialUsageCheckAt({ runtimeId, usageState, nowEpoch }) {
  if (usageState?.lastCheckEpoch) return usageState.lastCheckEpoch;

  // Fresh Claude installs should still wait a full interval before the first
  // /usage probe, but Codex needs an initial /status probe to create
  // usage-codex.json in the first place.
  if (runtimeId === 'codex') return 0;

  return nowEpoch;
}
