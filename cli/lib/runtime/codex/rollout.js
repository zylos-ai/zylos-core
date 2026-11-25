import fs from 'node:fs';
import path from 'node:path';
import { groupRunDir, sessionGroupRunRoot } from '../../session-group-paths.js';
import { currentRecordedWeekly, readSnapshot } from '../../session-usage-reader.js';

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
  return readCodexEventSample(event, identity, account);
}

function readCodexEventSample(event, identity, account) {
  const source = readCodexEventSource(event);
  if (!source) return null;
  const row = source.rows.findLast(item => item.type === 'event_msg' && item.payload?.type === 'token_count' &&
    (!account || item.payload.rate_limits));
  return codexSampleFromRow(source, row, identity);
}

function readCodexEventSource(event, files) {
  if (event?.v > 1) process.emitWarning('Reading known fields from a newer session event version');
  if (typeof event?.transcript_path !== 'string' || !path.isAbsolute(event.transcript_path)) return null;
  const rollout = readSnapshot(event.transcript_path);
  files?.push(fileVersion(event.transcript_path, rollout));
  if (rollout.error) return null;
  return { rows: completeRows(rollout.text), mtime: rollout.mtime };
}

function codexSampleFromRow({ rows, mtime }, row, identity) {
  if (!row || typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.timestamp)) return null;
  const day = new Date(row.timestamp.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== row.timestamp.slice(0, 10)) return null;
  const capturedAt = Date.parse(row.timestamp);
  if (!Number.isSafeInteger(capturedAt)) return null;
  // Bind the model to the sampled turn, never a later turn in the rollout.
  const model = rows.slice(0, rows.indexOf(row) + 1).findLast(item =>
    item.type === 'turn_context' && typeof item.payload?.model === 'string')?.payload.model ?? null;
  const info = row.payload.info;
  const used = info?.last_token_usage?.input_tokens;
  const ceiling = info?.model_context_window;
  const contextUsage = Number.isFinite(used) && used >= 0 && Number.isFinite(ceiling) && ceiling > 0 ? { used, ceiling } : null;
  return { sample: { identity: { runId: identity.runId, sessionId: identity.sessionId }, capturedAt,
    model, contextUsage, rateLimits: codexRateLimits(row.payload.rate_limits) }, mtime };
}

/** Recorded account evidence uses its recorded run/session, never a live identity. */
export function readRecordedCodexSample({ sessionGroup, env = process.env, now = Date.now(), includeWithoutQuota = false }) {
  const found = recordedCodexSample(sessionGroup, env, includeWithoutQuota);
  return found && (includeWithoutQuota || currentRecordedWeekly(found.sample.rateLimits, found.sample.capturedAt, now)) ? found : null;
}

function selectRecordedCodexSample(sessionGroup, file, includeWithoutQuota, files) {
  const events = readSnapshot(file);
  files.push(fileVersion(file, events));
  if (events.error) return null;
  const starts = completeRows(events.text).filter(row => row.v === 1 && row.event === 'session_start' &&
    row.runtime === 'codex' && row.session_group === sessionGroup && typeof row.run_id === 'string' &&
    row.run_id && typeof row.session_id === 'string' && row.session_id && Number.isSafeInteger(row.ts) && row.ts >= 0);
  // Runs are sequential: the newest run with any token sample ends this group's search.
  starts.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  for (const event of starts) {
    const key = JSON.stringify([event.run_id, event.session_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = readCodexEventSource(event, files);
    if (!source) continue;
    // Empty token updates can occur transiently within subscription runs. Once
    // this run reports quota, retain its latest quota-bearing update.
    const token = item => item.type === 'event_msg' && item.payload?.type === 'token_count';
    const last = source.rows.findLast(token);
    const row = includeWithoutQuota ? source.rows.findLast(item => token(item) && item.payload.rate_limits) ?? last : last;
    if (!row) continue;
    return codexSampleFromRow(source, row, { runId: event.run_id, sessionId: event.session_id });
  }
  return null;
}

// Dashboard rereads every group's recorded sample on each account poll, while most
// groups' files are unchanged. A group's selection is kept in this process with the
// size and modification time of every file it read (events.jsonl and each rollout
// examined) and reused while all of them still match. A read that saw a file change
// mid-read is not kept. Entries for group directories that no longer exist are
// dropped when the run root directory changes.
const recordedSelections = new Map();

function fileVersion(file, snapshot) {
  if (snapshot.error === 'missing') return { file, size: null, mtimeMs: null };
  return snapshot.error ? null : { file, size: snapshot.size, mtimeMs: snapshot.mtime };
}

function unchanged(files) {
  return files.every(({ file, size, mtimeMs }) => {
    let stat;
    try { stat = fs.statSync(file); } catch (error) { return error.code === 'ENOENT' && size === null; }
    return stat.size === size && stat.mtimeMs === mtimeMs;
  });
}

function recordedGroups(root) {
  let version;
  try {
    const stat = fs.statSync(root);
    version = `${stat.mtimeMs}:${stat.nlink}`;
  } catch {
    recordedSelections.delete(root);
    return null;
  }
  let cache = recordedSelections.get(root);
  if (!cache) recordedSelections.set(root, cache = { version, groups: new Map() });
  else if (cache.version !== version) {
    cache.version = version;
    let names;
    try { names = new Set(fs.readdirSync(root)); } catch { names = new Set(); }
    for (const group of cache.groups.keys()) if (!names.has(group)) cache.groups.delete(group);
  }
  return cache.groups;
}

function recordedCodexSample(sessionGroup, env, includeWithoutQuota) {
  const file = path.join(groupRunDir(sessionGroup, env), 'events.jsonl');
  const groups = recordedGroups(sessionGroupRunRoot(env));
  const cached = groups?.get(sessionGroup);
  if (cached?.includeWithoutQuota === includeWithoutQuota && unchanged(cached.files)) return structuredClone(cached.found);
  const files = [];
  const found = selectRecordedCodexSample(sessionGroup, file, includeWithoutQuota, files);
  if (groups && files.every(Boolean)) groups.set(sessionGroup, { includeWithoutQuota, files, found: structuredClone(found) });
  else groups?.delete(sessionGroup);
  return found;
}
