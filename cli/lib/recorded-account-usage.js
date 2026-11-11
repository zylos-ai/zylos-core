import fs from 'node:fs';
import path from 'node:path';
import { sessionGroupRunRoot, groupRunDir, zylosRoot } from './session-group-paths.js';
import { readJsonSample, readRecordedCodexSample, currentRecordedWeekly } from './session-usage-reader.js';

/** Before Claude's first API response, missing rate_limits is not account evidence.
 * API duration also survives compaction, when current_usage can become null. */
function claudeAccountSample(sample) {
  if (sample.error) return null;
  const { value } = sample, usage = value.context_window;
  const positive = number => Number.isFinite(number) && number > 0;
  const responded = (usage?.current_usage !== null && typeof usage?.current_usage === 'object' && !Array.isArray(usage.current_usage)) ||
    positive(value.cost?.total_api_duration_ms);
  if (!value.rate_limits && !responded) return null;
  return { value: value.rate_limits ?? null,
    recordedAt: Object.hasOwn(value.zylos ?? {}, 'capturedAt') ? value.zylos.capturedAt : sample.mtime };
}

/** Dashboard-only selection: the latest sample, including a no-quota response,
 * decides the result. Never search backwards for an older usable quota. */
export function readRecordedAccountUsage(runtime, env, now, liveSamples = []) {
  let latest = null;
  const consider = ({ value, recordedAt, live = false }) => {
    if (!Number.isFinite(recordedAt) || recordedAt < 0 || recordedAt > now) return;
    if (!latest || recordedAt > latest.recordedAt) {
      latest = { value, recordedAt, live };
    }
  };
  for (const sample of liveSamples) consider({ ...sample, live: true });
  let groups = [];
  try { groups = fs.readdirSync(sessionGroupRunRoot(env), { withFileTypes: true }); } catch {}
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    try {
      const dir = groupRunDir(group.name, env);
      if (runtime === 'claude') {
        const sample = claudeAccountSample(readJsonSample(path.join(dir, 'statusline.json'), 'usage'));
        if (sample) consider(sample);
      } else {
        const sample = readRecordedCodexSample({ sessionGroup: group.name, env, now, includeWithoutQuota: true });
        if (sample) consider({ value: sample.sample.rateLimits, recordedAt: sample.sample.capturedAt });
      }
    } catch { /* An unreadable group cannot hide other recorded account samples. */ }
  }
  if (runtime === 'claude' && !latest) {
    const sample = readJsonSample(path.join(zylosRoot(env), 'activity-monitor', 'usage.json'), 'status');
    if (!sample.error) consider({ value: { seven_day: { used_percentage: sample.value.weeklyAll?.percent,
      resets_at: sample.value.weeklyAll?.resets } }, recordedAt: Date.parse(sample.value.lastCheck) });
  }
  return latest && currentRecordedWeekly(latest.value, latest.recordedAt, now) ? latest : null;
}
