import fs from 'node:fs';

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
export function currentRecordedWeekly(value, recordedAt, now) {
  const weekly = value?.seven_day ?? value?.sevenDay;
  const percent = weekly?.used_percentage ?? weekly?.utilization ?? weekly?.usedPercentage;
  const reset = weekly?.resets_at ?? weekly?.resetsAt;
  const resetsAt = typeof reset === 'number' ? reset * 1000 : Date.parse(reset);
  return Number.isFinite(recordedAt) && recordedAt >= 0 && recordedAt <= now &&
    Number.isFinite(percent) && percent >= 0 && percent <= 100 && Number.isFinite(resetsAt) && resetsAt > now;
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
  return { value: reason ? null : sample.value, lastValue: reason === 'stale' ? sample.value : null,
    sampledAt, valid: !reason, reason: reason || null };
}

/** Model facts share the caller's validated usage identity. A captured explicit
 * override is a fallback; the mutable instance default is never a session fact. */
export function usageModelFacts(value, runtime, launchConfig, context) {
  const { model: actual, contextWindow: window } = context?.usageFacts(value) ?? {};
  const model = typeof actual === 'string' && actual ? actual :
    launchConfig?.mode === 'override' && launchConfig.runtime === runtime ? launchConfig.model : null;
  return { model, contextWindow: Number.isFinite(window) && window > 0 ? window : null };
}
