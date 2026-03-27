function leftToUsedPercent(leftPercentRaw) {
  const left = parseInt(leftPercentRaw, 10);
  if (Number.isNaN(left)) return null;
  return Math.max(0, Math.min(100, 100 - left));
}

export function parseCodexStatusFromPane(paneContent) {
  if (!paneContent) return null;

  const result = {
    sessionPercent: null,
    sessionResets: null,
    fiveHourPercent: null,
    fiveHourResets: null,
    weeklyAllPercent: null,
    weeklyAllResets: null,
    statusShape: 'unknown',
  };

  const contextLeftMatch = paneContent.match(/Context window:[^\n]*?(\d+)%\s*left/i);
  if (contextLeftMatch) {
    result.sessionPercent = leftToUsedPercent(contextLeftMatch[1]);
    result.statusShape = 'panel';
  }

  const fiveHourMatch = paneContent.match(/5h limit:[^\n]*?(\d+)%\s*left(?:[^\n]*?\(resets\s+([^)]+)\))?/i);
  if (fiveHourMatch) {
    result.fiveHourPercent = leftToUsedPercent(fiveHourMatch[1]);
    result.fiveHourResets = fiveHourMatch[2]?.trim() || null;
    result.statusShape = 'panel';
  }

  const weeklyMatch = paneContent.match(/Weekly limit:[^\n]*?(\d+)%\s*left(?:[^\n]*?\(resets\s+([^)]+)\))?/i);
  if (weeklyMatch) {
    result.weeklyAllPercent = leftToUsedPercent(weeklyMatch[1]);
    result.weeklyAllResets = weeklyMatch[2]?.trim() || null;
    result.statusShape = 'panel';
  }

  if (result.statusShape === 'unknown') {
    const statuslineMatch = paneContent.match(/·\s*(\d+)%\s*left\s*·/);
    if (statuslineMatch) {
      result.sessionPercent = leftToUsedPercent(statuslineMatch[1]);
      result.statusShape = 'statusline';
    }
  }

  if (result.statusShape === 'unknown') return null;
  return result;
}
