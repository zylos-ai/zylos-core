import { loadCoreModule } from './core-modules.js';
import { isDeepStrictEqual } from 'node:util';
import { validLaunchConfigSnapshot as validSnapshot } from './launch-config-shape.js';
const { assertSessionGroup } = await loadCoreModule('session-group-paths.js');
import { RestartRequestStore, validRequestId } from './restart-request-store.js';
import { MANUAL_WAKE_PROMPT } from './origin-prompts.js';

const nonempty = value => typeof value === 'string' && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validGroup(group) { try { assertSessionGroup(group); return true; } catch { return false; } }
export function validSupervisorRequest(request) {
  if (!object(request) || request.version !== 1 || !validRequestId(request.requestId)) return false;
  switch (request.type) {
    case 'delete_group': return validGroup(request.sessionGroup) && nonempty(request.actor) && request.actor.length <= 512
      && Number.isSafeInteger(request.cutoffId) && request.cutoffId >= 0
      && (!Object.hasOwn(request, 'operationId') || validRequestId(request.operationId))
      && (!Object.hasOwn(request, 'preview') || object(request.preview) &&
        Object.keys(request.preview).every(key => ['messages','attachments','files'].includes(key)) &&
        Object.values(request.preview).every(value => Number.isSafeInteger(value) && value >= 0));
    case 'restart_all': return request.reason === 'upgrade';
    case 'manual_restart': return (!Object.hasOwn(request, 'expectedRunId') || nonempty(request.expectedRunId))
      && (!Object.hasOwn(request, 'expectedSessionId') || typeof request.expectedSessionId === 'string')
      && (!Object.hasOwn(request, 'sessionGroup') || validGroup(request.sessionGroup));
    case 'ready_for_config_reclaim': return validGroup(request.sessionGroup) && nonempty(request.expectedRunId);
    case 'defer_reclaim': return validGroup(request.sessionGroup) && nonempty(request.expectedRunId)
      && typeof request.minutes === 'number' && nonempty(request.reason) && request.reason.trim().length > 0;
    case 'mode_switch': return ['single', 'multi'].includes(request.target);
    case 'start_attempt': return true; // The runtime owner validates its complete request in the runtime queue.
    default: return false;
  }
}

/** One queue is shared with lifecycle mutations; external waits must stay outside it. */
export class SupervisorAdmission {
  constructor({ store = new RestartRequestStore(), db, readMode, listRuns, readRun,
    resolveLaunchConfig, preflightReclaim, deferReclaim, modeSwitch, startAttempt, diagnostic = () => {}, now = Date.now } = {}) {
    Object.assign(this, { store, db, readMode, listRuns, readRun, resolveLaunchConfig, preflightReclaim, deferReclaim, modeSwitch, startAttempt, diagnostic, now });
    this.open = false; this.tail = Promise.resolve();
  }
  serialize(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  restore() { const requests = this.store.read(); return { requests, manual: requests.find(row => row.reason === 'manual_restart') ?? null }; }
  openEntry() { this.open = true; }
  closeEntry() { this.open = false; }
  readRequests() { return this.store.read(); }
  async handle(request) {
    const envelope = { version: 1, type: request?.type, requestId: request?.type === 'start_attempt' && typeof request.requestId !== 'string' ? null : request?.requestId ?? null };
    const reply = result => ({ ...envelope, ...result });
    if (!validSupervisorRequest(request)) return reply({ ok: false, code: 'invalid_request' });
    if (!this.open) {
      if (request.type === 'start_attempt') throw Object.assign(new Error('Runtime admission is not ready'), { code: 'START_ADMISSION_CLOSED' });
      return reply({ ok: false, code: 'entry_not_open' });
    }
    if (request.type === 'start_attempt') return this.startAttempt(request);
    return this.serialize(async () => {
      if (!this.open) return reply({ ok: false, code: 'entry_not_open' });
      try {
        // Mode switching has its own ordered checks; F9 is consulted only after
        // open transition, configuration, noop and legacy-session checks.
        if (request.type === 'mode_switch') {
          return reply(await this.modeSwitch(request));
        }
        if (request.type === 'defer_reclaim') {
          return reply(await this.deferReclaim(request));
        }
        if (request.type === 'ready_for_config_reclaim') {
          let rows = [];
          try { rows = this.store.read(); }
          catch (error) {
            if (error.code !== 'requests_unreadable') throw error;
            if (request.sessionGroup === 'origin') {
              return reply({ ok: false, result: 'rejected', reason: error.code });
            }
          }
          return reply(await this.config(request, rows));
        }
        const rows = this.store.read();
        switch (request.type) {
          case 'delete_group': return reply(await this.deleteGroup(request, rows));
          case 'restart_all': return reply(await this.restart(request, rows));
          case 'manual_restart': return reply(await this.manual(request, rows));
          default: return reply({ ok: false, code: 'invalid_request' });
        }
      } catch (error) {
        if (request.type === 'delete_group' && ['DELETION_PREVIEW_STALE', 'DELETION_OWNERSHIP_MISMATCH', 'DRAFT_BECAME_ACTIVE'].includes(error.code)) return reply({ ok: false, result: 'rejected', reason: error.code });
        if (error.code !== 'requests_unreadable' || request.type === 'ready_for_config_reclaim') throw error;
        return reply(['manual_restart', 'delete_group', 'defer_reclaim'].includes(request.type)
          ? { ok: false, result: 'rejected', reason: error.code } : { ok: false, code: error.code });
      }
    });
  }
  async restart(request, rows) {
    const existing = rows.find(row => row.requestId === request.requestId);
    if (existing) return existing.reason === 'upgrade' ? { ok: true, result: 'already_accepted', runCount: existing.runIds.length } : { ok: false, code: 'request_conflict' };
    if (rows.some(row => row.reason === 'manual_restart')) return { ok: false, code: 'manual_restart_pending' };
    const transition = await this.db.getModeTransition();
    const mode = (await this.readMode()).mode ?? 'single';
    if (mode === 'single' && !transition) return { ok: false, code: 'single_mode' };
    const runs = await this.listRuns();
    if (!Array.isArray(runs) || runs.some(run => !nonempty(run?.runId))) {
      throw Object.assign(new Error('Cannot snapshot all live run identities'), { code: 'IDENTITY_UNAVAILABLE' });
    }
    const runIds = [...new Set(runs.map(run => run.runId))];
    if (!runIds.length) {
      await this.diagnostic({ event: 'restart_done', requestId: request.requestId });
      return { ok: true, result: 'done_empty', runCount: 0 };
    }
    this.store.write([...rows, { requestId: request.requestId, reason: 'upgrade', acceptedAt: this.now(), runIds }]);
    return { ok: true, result: 'accepted', runCount: runIds.length };
  }
  async deleteGroup(request, rows) {
    const reject = reason => ({ ok: false, result: 'rejected', reason });
    if (request.sessionGroup === 'origin') return reject('origin_forbidden');
    const operationId = request.operationId ?? request.requestId;
    const existing = await this.db.getGroupDeletionAudit(operationId);
    if (existing?.sessionGroup === request.sessionGroup && existing.status === 'done') return { ok: true, result: 'already_completed', operationId, runId: existing.runId };
    if ((await this.readMode()).mode !== 'multi') return reject('not_multi');
    if (await this.db.getModeTransition() || await this.db.getDrainFence('*')) return reject('transition_open');
    const active = await this.db.getActiveDeletion(request.sessionGroup);
    if (active && (active.operationId !== operationId || active.cutoffId !== request.cutoffId)) return reject('DELETION_OWNERSHIP_MISMATCH');
    if (!active && await this.db.getDrainFence(request.sessionGroup)) return reject('fence_conflict');
    const run = active ? { runId: active.runId } : await this.readRun(request.sessionGroup);
    if (!active && run !== null && (!nonempty(run?.runId) || !run.ready)) return reject('identity_unavailable');
    const deletion = active ?? await this.db.beginGroupDeletion(request.sessionGroup, { operationId, actor: request.actor,
      runId: run?.runId ?? null, preview: request.preview, cutoffId: request.cutoffId });
    // The lifecycle owner removes only this group's queued manual/upgrade intent.
    // Its fence already excludes new admission before the intent is changed.
    const remaining = rows.flatMap(row => {
      if (row.reason === 'manual_restart') return row.mode === 'multi' && row.sessionGroup === request.sessionGroup ? [] : [row];
      if (row.reason === 'upgrade' && run?.runId && row.runIds.includes(run.runId)) {
        const runIds = row.runIds.filter(id => id !== run.runId);
        return runIds.length ? [{ ...row, runIds }] : [];
      }
      return [row];
    });
    if (remaining.length !== rows.length || remaining.some((row, index) => row !== rows[index])) this.store.write(remaining);
    return { ok: true, result: active ? 'already_accepted' : 'accepted', operationId: deletion.operationId, runId: deletion.runId };
  }
  async manual(request, rows) {
    const rejected = reason => ({ ok: false, result: 'rejected', reason });
    const existing = rows.find(row => row.requestId === request.requestId);
    if (existing) return existing.reason === 'manual_restart'
        && existing.expectedRunId === request.expectedRunId
        && (existing.mode === 'single' ? null : existing.sessionGroup ?? 'origin') === (request.sessionGroup ?? (existing.mode === 'single' ? null : 'origin'))
      ? { ok: true, result: 'already_accepted' } : rejected('request_conflict');
    if (await this.db.getModeTransition()) return rejected('transition_open');
    if (rows.some(row => row.reason === 'upgrade')) return rejected('restart_all_pending');
    const mode = (await this.readMode()).mode ?? 'single';
    if (mode === 'single' && Object.hasOwn(request, 'sessionGroup')) return rejected('not_multi');
    const group = mode === 'multi' ? request.sessionGroup ?? 'origin' : null;
    if (await this.db.getDrainFence(group ?? 'origin') || await this.db.getDrainFence('*')) return rejected('fence_conflict');
    if (rows.some(row => row.reason === 'manual_restart')) return rejected('manual_restart_pending');
    const run = await this.readRun(group);
    // null means both the process and tmux absence were positively observed.
    if (!request.expectedRunId && run !== null) return rejected('target_required');
    if (run === null) {
      if (mode === 'multi' && group === 'origin') {
        try { await this.db.insertControl(MANUAL_WAKE_PROMPT, { sessionGroup: 'origin', priority: 2, appendAckSuffix: false }); }
        catch { return rejected('wake_failed'); }
      }
      return { ok: true, result: 'already_stopped' };
    }
    if (nonempty(run?.runId) && run.runId !== request.expectedRunId) return { ok: false, result: 'stale_target', currentRunId: run.runId };
    if (!nonempty(run?.runId)) return rejected('identity_unavailable');
    if (!run.ready) return rejected('not_ready');
    if (request.expectedSessionId !== undefined && request.expectedSessionId !== run.sessionId) return rejected('identity_unavailable');
    const row = { requestId: request.requestId, reason: 'manual_restart', acceptedAt: this.now(), runIds: [run.runId],
      mode, expectedRunId: run.runId };
    if (Object.hasOwn(request, 'sessionGroup')) row.sessionGroup = group;
    this.store.write([...rows, row]);
    return { ok: true, result: 'accepted' };
  }
  async config(request, rows) {
    const reject = reason => ({ ok: false, result: 'rejected', reason });
    if ((await this.readMode()).mode !== 'multi') return reject('not_multi');
    if (await this.db.getModeTransition() || await this.db.getDrainFence('*')) return reject('transition_open');
    const run = await this.readRun(request.sessionGroup);
    if (run?.runId !== request.expectedRunId) return reject('run_changed');
    if (!run.ready) return reject('not_ready');
    if (!validSnapshot(run.launchConfig)) return reject('snapshot_unavailable');
    const fence = await this.db.getDrainFence(request.sessionGroup);
    // Deletion already owns stopping this run. Let its in-flight configuration
    // control finish without replacing the delete fence or scheduling a restart.
    if (fence && (!['model_config', 'delete'].includes(fence.reason) || fence.runId !== request.expectedRunId)) return reject('other_fence');
    if (rows.some(row => row.reason === 'manual_restart' &&
      (row.mode === 'single' ? null : row.sessionGroup ?? 'origin') === request.sessionGroup)) return reject('manual_restart_pending');
    if (fence) return { ok: true, result: 'already_accepted' };
    const expected = await this.resolveLaunchConfig(request.sessionGroup);
    if (!validSnapshot(expected)) throw Object.assign(new Error('Expected launch configuration is invalid'), { code: 'CONFIG_UNREADABLE' });
    if (isDeepStrictEqual(run.launchConfig, expected)) return { ok: true, result: 'unchanged' };
    if (typeof this.preflightReclaim !== 'function') throw Object.assign(new Error('Reclaim preflight is unavailable'), { code: 'DEPENDENCY_UNAVAILABLE' });
    await this.preflightReclaim({ ...run, sessionGroup: request.sessionGroup }, { configuration: { mode: 'multi' } });
    await this.db.setDrainFence(request.sessionGroup, { reason: 'model_config', runId: request.expectedRunId });
    return { ok: true, result: 'accepted' };
  }
}
