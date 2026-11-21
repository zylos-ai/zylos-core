import fs from 'node:fs';
import path from 'node:path';
import { groupRunDir, zylosRoot } from '../../session-group-paths.js';
import { readJsonSample } from '../../session-usage-reader.js';

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

const accountQuota = Object.freeze({
  readLiveSample({ sessionGroup, identity, env }) {
    const sample = readJsonSample(path.join(groupRunDir(sessionGroup ?? 'origin', env), 'statusline.json'), 'usage');
    if (sample.error || sample.identity.runId !== identity.runId || sample.identity.sessionId !== identity.sessionId || !sample.value.rate_limits) return null;
    return { value: sample.value.rate_limits, mtime: sample.mtime, recordedAt: sample.sampledAt ?? sample.mtime };
  },
  readRecordedSample({ sessionGroup, env }) {
    return claudeAccountSample(readJsonSample(path.join(groupRunDir(sessionGroup, env), 'statusline.json'), 'usage'));
  },
  stateFile: 'usage.json',
  alertStateFile: 'usage-alert-state.json',
  sampleOnStart: false,
});

export const usage = Object.freeze({
  accountQuota,
  legacyAccountRecord({ env }) {
    const sample = readJsonSample(path.join(zylosRoot(env), 'activity-monitor', accountQuota.stateFile), 'status');
    if (sample.error) return null;
    return { value: { seven_day: { used_percentage: sample.value.weeklyAll?.percent,
      resets_at: sample.value.weeklyAll?.resets } }, recordedAt: Date.parse(sample.value.lastCheck) };
  },
  healthQuota({ runDir, runId, sessionId }) {
    try {
      const file = path.join(runDir, 'statusline.json');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return null;
      const sample = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (sample?.session_id !== sessionId || sample.zylos?.v !== 1 || sample.zylos.runId !== runId) return null;
      return { observedAt: sample.zylos.capturedAt, rateLimits: sample.rate_limits };
    } catch { return null; }
  },
});
