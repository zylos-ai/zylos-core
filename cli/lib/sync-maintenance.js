import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zylosRoot, assertSessionGroup } from './session-group-paths.js';
import { maintenancePurposeFile, readMaintenancePurpose } from '../../skills/comm-bridge/scripts/maintenance-session.js';
import { withMemoryLock } from '../../skills/zylos-memory/scripts/sync-lock.js';

const phases = new Set(['queued', 'running', 'finishing', 'complete', 'failed', 'ordinary']);
const active = row => ['running', 'finishing'].includes(row.phase);
const unavailableFiles = new Set();
function reportUnavailable(file, error, diagnostic) {
  if (unavailableFiles.has(file)) return;
  unavailableFiles.add(file);
  try { diagnostic('sync_maintenance_unavailable', { reason: error.code ?? error.message }); }
  catch { /* Diagnostic failure cannot suspend ordinary delivery. */ }
}
const failure = cause => Object.assign(new Error('Sync maintenance requests are unreadable', { cause }), { code: 'SYNC_MAINTENANCE_UNREADABLE' });
export const maintenanceFile = (env = process.env) => path.join(zylosRoot(env), 'activity-monitor', 'sync-maintenance.json');
function read(file) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { v: 1, groups: {} }; throw failure(error); }
  if (!state || state.v !== 1 || !state.groups || typeof state.groups !== 'object' || Array.isArray(state.groups)) throw failure();
  let occupied = 0;
  for (const [group, row] of Object.entries(state.groups)) {
    try { assertSessionGroup(group); } catch (error) { throw failure(error); }
    if (!row || row.sessionGroup !== group || typeof row.id !== 'string' || !phases.has(row.phase) ||
      !Number.isFinite(row.queuedAt) || !Number.isFinite(row.windowMs) || row.windowMs <= 0 ||
      (row.lastAttemptAt != null && !Number.isFinite(row.lastAttemptAt)) ||
      (active(row) && (typeof row.runId !== 'string' || !row.runId))) throw failure();
    if (active(row) && ++occupied > 1) throw failure();
  }
  return state;
}
function publish(file, state) {
  const directory = path.dirname(file), temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(state) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const parent = fs.openSync(directory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* This writer's unpublished temporary file only. */ }
    throw error;
  }
}

/** One shared durable request ledger. Router and supervisor mutations use the
 * existing kernel lock, so restart/process races cannot multiply attempts. */
export function createMaintenanceRequests({ env = process.env, now = Date.now,
  diagnostic = (event, fields) => console.error(`[sync-maintenance] ${event}: ${fields.reason}`),
} = {}) {
  const file = maintenanceFile(env);
  const change = action => withMemoryLock(path.join(path.dirname(file), 'sync-maintenance-lock'), async () => {
    const state = read(file), result = await action(state);
    if (result !== false) {
      // Publish the ledger first. An unsuccessful claim cannot mark an ordinary
      // runtime as maintenance. Receipt failure aborts activation before launch.
      publish(file, state);
      if (result?.runId) publish(maintenancePurposeFile(result.sessionGroup, env), {
        sessionGroup: result.sessionGroup, runId: result.runId, phase: result.phase,
      });
    }
    return result === false ? null : result;
  }, { waitMs: 2000 });
  const api = {
    file,
    read: () => Object.values(read(file).groups),
    observe: () => {
      try { const rows = api.read(); unavailableFiles.delete(file); return rows; }
      catch (error) { reportUnavailable(file, error, diagnostic); return []; }
    },
    cancelMaintenanceForConversation: async (group, runId) => {
      try { return await api.cancelMaintenance(group, runId); }
      catch (error) {
        reportUnavailable(file, error, diagnostic);
        // Real input ends this run's restricted purpose even if the scheduler's
        // ledger is unavailable. Do not change another run's receipt.
        const purposeFile = maintenancePurposeFile(group, env);
        try {
          const purpose = JSON.parse(fs.readFileSync(purposeFile, 'utf8'));
          if (!runId || purpose.runId === runId) publish(purposeFile, { ...purpose, phase: 'ordinary' });
        } catch (cause) {
          if (cause.code !== 'ENOENT') {
            try { diagnostic('sync_maintenance_purpose_unavailable', { reason: cause.code ?? cause.message }); }
            catch { /* Diagnostic failure cannot suspend ordinary delivery. */ }
          }
        }
        return null;
      }
    },
    listMaintenanceRequests: async () => Object.values(read(file).groups).filter(row => row.phase === 'queued').sort((a, b) => a.queuedAt - b.queuedAt),
    queue: ({ sessionGroup, reason, target, windowMs = 21600000 }) => change(state => {
      assertSessionGroup(sessionGroup);
      if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new TypeError('Invalid Sync maintenance window');
      const previous = Object.hasOwn(state.groups, sessionGroup) ? state.groups[sessionGroup] : null;
      if (previous && (['queued', 'running', 'finishing'].includes(previous.phase) ||
        previous.lastAttemptAt != null && now() - previous.lastAttemptAt < windowMs)) return false;
      return state.groups[sessionGroup] = { id: randomUUID(), sessionGroup, phase: 'queued', queuedAt: now(),
        windowMs, lastAttemptAt: previous?.lastAttemptAt ?? null, reason, target, runId: null };
    }),
    claimMaintenance: (group, runId) => change(state => {
      const row = state.groups[group];
      if (!row || row.phase !== 'queued' || Object.values(state.groups).some(active)) return false;
      if (typeof runId !== 'string' || !runId) throw new TypeError('Invalid maintenance run');
      Object.assign(row, { phase: 'running', runId, startedAt: now(), lastAttemptAt: now() });
      return row;
    }),
    claimStartup: (group, runId) => change(state => {
      const row = state.groups[group];
      if (!row || row.runId !== runId || row.phase !== 'running' || row.startupClaimed) return false;
      row.startupClaimed = true; return row;
    }),
    cancelMaintenance: (group, runId) => change(state => {
      const row = state.groups[group];
      if (!row || !['queued', 'running', 'finishing'].includes(row.phase) || runId && row.runId && row.runId !== runId) return false;
      Object.assign(row, { phase: 'ordinary', finishedAt: now() }); return row;
    }),
    update: (group, runId, fields) => change(state => {
      const row = state.groups[group];
      if (!row || row.runId !== runId || !active(row)) return false;
      const purpose = readMaintenancePurpose({ ...env, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: runId });
      if (purpose?.phase === 'ordinary') return false;
      const allowed = ['controlId', 'target', 'phase', 'outcome', 'failure', 'finishedAt', 'releaseRequested'];
      if (Object.keys(fields).some(key => !allowed.includes(key)) || fields.phase && !phases.has(fields.phase)) throw new TypeError('Invalid maintenance update');
      Object.assign(row, fields); return row;
    }),
  };
  return api;
}

/** Exact persisted purpose; no tmux/env flag survives conversion to real work. */
export function readMaintenanceRun({ env = process.env, sessionGroup = env.ZYLOS_SESSION_GROUP, runId = env.ZYLOS_RUN_ID } = {}) {
  if (!sessionGroup || !runId) return null;
  const purpose = readMaintenancePurpose({ ...env, ZYLOS_SESSION_GROUP: sessionGroup, ZYLOS_RUN_ID: runId });
  if (purpose?.phase === 'ordinary') return null;
  const rows = createMaintenanceRequests({ env }).observe();
  const row = rows.find(row => row.sessionGroup === sessionGroup);
  return row && row.runId === runId && active(row) ? row : null;
}
