export function parseUsageFromPane(paneContent) {
  if (!paneContent) return null;

  const result = {};

  const sessionMatch = paneContent.match(/Current session[\s\S]*?(\d+)%\s*used/i);
  if (sessionMatch) result.session = parseInt(sessionMatch[1], 10);

  const weekAllMatch = paneContent.match(/Current week \(all models\)[\s\S]*?(\d+)%\s*used/i);
  if (weekAllMatch) result.weeklyAll = parseInt(weekAllMatch[1], 10);

  const weekSonnetMatch = paneContent.match(/Current week \(Sonnet[^)]*\)[\s\S]*?(\d+)%\s*used/i);
  if (weekSonnetMatch) result.weeklySonnet = parseInt(weekSonnetMatch[1], 10);

  const resetMatches = [...paneContent.matchAll(/Resets\s+(.+?)(?:\n|$)/gi)];
  if (resetMatches.length >= 1) result.sessionResets = resetMatches[0][1].trim();
  if (resetMatches.length >= 2) result.weeklyAllResets = resetMatches[1][1].trim();
  if (resetMatches.length >= 3) result.weeklySonnetResets = resetMatches[2][1].trim();

  if (result.session === undefined && result.weeklyAll === undefined) return null;
  return result;
}
