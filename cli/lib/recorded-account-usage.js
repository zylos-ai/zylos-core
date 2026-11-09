import fs from 'node:fs';
import path from 'node:path';
import { sessionGroupRunRoot, groupRunDir, zylosRoot } from './session-group-paths.js';
import { readJsonSample, readRecordedCodexSample, currentRecordedWeekly } from './session-usage-reader.js';

/** Dashboard-only historical fallback. Expired or undated windows are unknown. */
export function readRecordedAccountUsage(runtime, env, now) {
  let latest = null;
  const consider = (value, recordedAt) => {
    if (!currentRecordedWeekly(value, recordedAt, now)) return;
    if (!latest || recordedAt > latest.recordedAt) latest = { value, recordedAt, live: false };
  };
  let groups = [];
  try { groups = fs.readdirSync(sessionGroupRunRoot(env), { withFileTypes: true }); } catch {}
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    try {
      const dir = groupRunDir(group.name, env);
      if (runtime === 'claude') {
        const sample = readJsonSample(path.join(dir, 'statusline.json'), 'usage');
        if (!sample.error) consider(sample.value.rate_limits,
          Object.hasOwn(sample.value.zylos ?? {}, 'capturedAt') ? sample.value.zylos.capturedAt : sample.mtime);
      } else {
        const sample = readRecordedCodexSample({ sessionGroup: group.name, env, now });
        if (sample) consider(sample.sample.rateLimits, sample.sample.capturedAt);
      }
    } catch { /* An unreadable group cannot hide other recorded account samples. */ }
  }
  if (runtime === 'claude' && !latest) {
    const sample = readJsonSample(path.join(zylosRoot(env), 'activity-monitor', 'usage.json'), 'status');
    if (!sample.error) consider({ seven_day: { used_percentage: sample.value.weeklyAll?.percent,
      resets_at: sample.value.weeklyAll?.resets } }, Date.parse(sample.value.lastCheck));
  }
  return latest;
}
