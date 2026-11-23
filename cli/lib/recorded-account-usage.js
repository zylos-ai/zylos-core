import fs from 'node:fs';
import { sessionGroupRunRoot } from './session-group-paths.js';
import { currentRecordedWeekly } from './session-usage-reader.js';
import { UNSUPPORTED } from './runtime/contract.js';
import { findRuntime } from './runtime/index.js';

/** Dashboard-only selection: the latest sample, including a no-quota response,
 * decides the result. Never search backwards for an older usable quota. */
export async function readRecordedAccountUsage(runtimeId, env, now, liveSamples = []) {
  const runtime = await findRuntime(runtimeId);
  const usage = runtime?.usage ?? UNSUPPORTED;
  if (usage === UNSUPPORTED || usage.accountQuota === UNSUPPORTED) return null;
  const { accountQuota, legacyAccountRecord } = usage;
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
      const sample = accountQuota.readRecordedSample({ sessionGroup: group.name, env, now });
      if (sample) consider(sample);
    } catch { /* An unreadable group cannot hide other recorded account samples. */ }
  }
  if (!latest && legacyAccountRecord !== UNSUPPORTED) {
    const sample = legacyAccountRecord({ env });
    if (sample) consider(sample);
  }
  return latest && currentRecordedWeekly(latest.value, latest.recordedAt, now) ? latest : null;
}
