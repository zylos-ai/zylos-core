import { openReadStore } from './c4-read-store.js';
import { ZYLOS_DIR } from './config.js';

/** Read wake demand and gates without modifying the C4 database. */
export async function readOriginFacts({ zylosDir = ZYLOS_DIR, nowSec = Math.floor(Date.now() / 1000), open = openReadStore } = {}) {
  try {
    const { store, close } = await open(zylosDir);
    try {
      const need = await store.getOriginNeed(nowSec);
      const transition = await store.getModeTransition();
      const fence = await store.getDrainFence('origin') ?? await store.getDrainFence('*');
      const times = [need.inbound.oldestAt, need.controls.oldestAt].filter(time => time !== null);
      return { originNeed: { inbound: need.inbound.count, controls: need.controls.count,
        oldestAt: times.length ? Math.min(...times) : null }, transitionOpen: transition !== null, fenced: fence !== null };
    } finally { await close(); }
  } catch (error) {
    return { originNeed: { error: { code: 'READ_FAILED', message: error.message ?? String(error) } },
      transitionOpen: null, fenced: null };
  }
}

/** Human-facing interpretation; the status JSON retains the observed presence. */
export function describeOrigin({ view, origin, originNeed, runtimeHealth, targetRuntime, nowSec }) {
  if (view !== 'multi') return { state: origin.presence, failure: false };
  const readable = originNeed && !originNeed.error;
  const needed = readable && originNeed.inbound + originNeed.controls > 0;
  const health = targetRuntime !== null ? runtimeHealth?.[targetRuntime] : null;
  if (needed && health?.health === 'auth_failed') return { state: 'auth_wait', failure: true };
  if (origin.presence !== 'not_running') return { state: origin.presence, failure: false };
  if (!readable) return { state: 'need_unreadable', failure: true };
  if (!needed) return { state: 'sleeping', failure: false };
  if (health?.health === 'rate_limited') return { state: 'rate_wait', failure: false };
  if (nowSec - originNeed.oldestAt < 300) return { state: 'waking', failure: false };
  return { state: 'wake_overdue', failure: true };
}

export function formatOriginDescription(description, targetRuntime, originNeed) {
  const messages = {
    sleeping: 'Origin is asleep; it wakes automatically when there is work.',
    waking: 'Origin is waking up.',
    wake_overdue: 'Origin has pending work but has not started for over 5 minutes. Check router startup diagnostics: ~/zylos/comm-bridge/router-events.jsonl',
    auth_wait: `Origin is waiting for ${targetRuntime} authentication: messages to Origin cannot be delivered. Log in again; it recovers automatically.`,
    rate_wait: `Origin is waiting for the ${targetRuntime} rate limit to clear; it retries waking on the rate-limit schedule and resumes after recovery.`,
    need_unreadable: `Origin wake status unavailable: ${originNeed?.error?.message ?? 'unknown read error'}`,
  };
  return messages[description.state] ?? null;
}
