export function shouldStartUsageCheck({
  runtimeId,
  claudeState,
  idleSeconds,
  currentTime,
  lastUsageCheckAt,
  checkInterval,
  inPrompt,
  promptUpdatedAt,
  localHour,
  activeHoursStart,
  activeHoursEnd,
  pendingQueueCount,
  lockBusy,
  backoffUntil,
  circuitUntil,
}) {
  if (runtimeId !== 'claude') return false;
  if (claudeState !== 'idle') return false;
  if (idleSeconds < checkInterval.idleGate) return false;
  if ((currentTime - lastUsageCheckAt) < checkInterval.seconds) return false;

  if (inPrompt) {
    const updatedAt = promptUpdatedAt || 0;
    if ((currentTime - updatedAt) < 600) return false;
  }

  if (localHour < activeHoursStart || localHour >= activeHoursEnd) return false;
  if (pendingQueueCount > 0) return false;
  if (lockBusy) return false;
  if (backoffUntil && currentTime < backoffUntil) return false;
  if (circuitUntil && currentTime < circuitUntil) return false;

  return true;
}
