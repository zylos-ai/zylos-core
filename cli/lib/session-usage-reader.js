import fs from 'node:fs';
import path from 'node:path';
import { groupRunDir } from './session-group-paths.js';

// Open once: an atomic rename cannot splice bytes from two different files.
export function readSnapshot(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const before = fs.fstatSync(fd);
    const text = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { error: 'unparseable', mtime: before.mtimeMs };
    return { text, mtime: before.mtimeMs };
  } catch (error) { return { error: error.code === 'ENOENT' ? 'missing' : 'unparseable', mtime: null }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readJsonSample(file, kind) {
  const source = readSnapshot(file);
  let value;
  try { if (!source.error) value = JSON.parse(source.text); }
  catch { source.error = 'unparseable'; }
  if (!source.error && (!value || typeof value !== 'object' || Array.isArray(value))) source.error = 'unparseable';
  const sampledAt = kind === 'status' ? source.mtime : Number.isSafeInteger(value?.zylos?.capturedAt) ? value.zylos.capturedAt : null;
  const identity = kind === 'status' ? { runId: value?.runId, sessionId: value?.sessionId } : { runId: value?.zylos?.runId, sessionId: value?.session_id };
  const versionUnknown = kind === 'usage' && value?.zylos && value.zylos.v !== 1;
  return { value, sampledAt, identity, mtime: source.mtime, error: source.error || (versionUnknown ? 'version_unknown' : null) };
}
function completeRows(text) {
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
export function codexRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const windows = {};
  for (const value of Object.values(raw)) {
    const name = value?.window_minutes === 300 ? 'fiveHour' : value?.window_minutes === 10080 ? 'sevenDay' : null;
    if (name && Number.isFinite(value.used_percent)) windows[name] = { usedPercentage: value.used_percent,
      ...(Number.isFinite(value.resets_at) ? { resetsAt: value.resets_at } : {}) };
  }
  return Object.keys(windows).length ? windows : null;
}
/** Caller owns the surrounding I0/sample/I1 observation on one connection. */
export function readCodexSampleForIdentity({ sessionGroup, identity, env = process.env, account = false }) {
  if (!identity?.present || !identity.ready || identity.runtime !== 'codex') return null;
  const events = readSnapshot(path.join(groupRunDir(sessionGroup ?? 'origin', env), 'events.jsonl'));
  if (events.error) return null;
  const event = completeRows(events.text).findLast(row => Number.isInteger(row.v) && row.v >= 1 && Number.isSafeInteger(row.ts) && row.ts >= 0 && row.event === 'session_start' && row.runtime === 'codex' &&
    row.session_group === (sessionGroup ?? 'origin') && row.run_id === identity.runId && row.session_id === identity.sessionId);
  if (event?.v > 1) process.emitWarning('Reading known fields from a newer session event version');
  if (typeof event?.transcript_path !== 'string' || !path.isAbsolute(event.transcript_path)) return null;
  const rollout = readSnapshot(event.transcript_path);
  if (rollout.error) return null;
  const row = completeRows(rollout.text).findLast(item => item.type === 'event_msg' && item.payload?.type === 'token_count' &&
    (!account || item.payload.rate_limits));
  if (!row || typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.timestamp)) return null;
  const day = new Date(row.timestamp.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== row.timestamp.slice(0, 10)) return null;
  const capturedAt = Date.parse(row.timestamp);
  if (!Number.isSafeInteger(capturedAt)) return null;
  const info = row.payload.info;
  const used = info?.last_token_usage?.input_tokens;
  const ceiling = info?.model_context_window;
  const contextUsage = Number.isFinite(used) && used >= 0 && Number.isFinite(ceiling) && ceiling > 0 ? { used, ceiling } : null;
  return { sample: { identity: { runId: identity.runId, sessionId: identity.sessionId }, capturedAt,
    contextUsage, rateLimits: codexRateLimits(row.payload.rate_limits) }, mtime: rollout.mtime };
}

export function sameIdentity(a, b) {
  return Boolean(a?.present && a.ready && b?.present && b.ready &&
    ['runId', 'sessionId', 'runtime', 'createdAt', 'serverGeneration', 'tmuxSessionId', 'paneId'].every(key => a[key] === b[key]));
}
export function sampleResult(sample, first, last, freshnessMs, now) {
  const sampledAt = sample?.sampledAt ?? null;
  let reason = !first.present ? 'not_running' : !first.ready ? 'starting' : !sameIdentity(first, last) ? 'identity_changed' : sample?.error;
  if (!reason) {
    if (!sample?.value) reason = 'missing';
    else if (!sample.identity?.runId || !sample.identity?.sessionId) reason = 'identity_missing';
    else if (sample.identity.runId !== first.runId || sample.identity.sessionId !== first.sessionId) reason = 'identity_mismatch';
    else if (!Number.isFinite(sampledAt) || now - sampledAt > freshnessMs) reason = 'stale';
  }
  return { value: reason ? null : sample.value, sampledAt, valid: !reason, reason: reason || null };
}
