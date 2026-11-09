import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import Database from '../../skills/comm-bridge/scripts/sqlite-driver.js';
import * as schema from '../../skills/comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../skills/comm-bridge/scripts/sqlite-schema.js';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import { parseSessionGroup } from '../../skills/comm-bridge/scripts/c4-session-group.js';
import { submit } from './am-sock-client.js';
import { groupMemoryDir, groupRunDir } from './session-group-paths.js';
import { ownedPath } from '../../skills/comm-bridge/scripts/owned-path.js';

export const groupDeletionCliPath = fileURLToPath(new URL('./group-delete-cli.js', import.meta.url));
const error = (code, message) => Object.assign(new Error(message), { code });

function targetOf(value) {
  if (typeof value === 'string') value = { sessionGroup: value };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['sessionGroup', 'draftLocalId'].includes(key)) ||
      (value.sessionGroup === undefined) === (value.draftLocalId === undefined)) {
    throw error('INVALID_ARGUMENT', 'Exactly one conversation target is required');
  }
  if (value.sessionGroup !== undefined) {
    if (!parseSessionGroup(value.sessionGroup)) throw error('SESSION_GROUP_INVALID', 'Invalid session group');
    if (value.sessionGroup === 'origin') throw error('ORIGIN_DELETE_FORBIDDEN', 'Origin cannot be deleted');
  } else if (typeof value.draftLocalId !== 'string' || !parseSessionGroup(`dashboard:${value.draftLocalId}`)) {
    throw error('INVALID_ARGUMENT', 'Invalid draft identifier');
  }
  return value;
}


function countFiles(base, target) {
  const file = ownedPath(base, target);
  let stat;
  try { stat = fs.lstatSync(file); } catch (cause) { if (cause.code === 'ENOENT') return 0; throw cause; }
  if (!stat.isDirectory()) return 1;
  return fs.readdirSync(file).reduce((total, name) => total + countFiles(base, path.join(file, name)), 0);
}

function removeTree(base, target) {
  const candidate = ownedPath(base, target), files = countFiles(base, candidate);
  fs.rmSync(candidate, { recursive: true, force: true });
  return files;
}

/** All mutation entry points delegate here; the Dashboard invokes it in a Core child process. */
export function createGroupDeletion({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'), homeDir = process.env.HOME || os.homedir(),
  database: injectedDatabase, store: injectedStore, participant: injectedParticipant,
  requestStop = submit, uuid = randomUUID, now = Date.now, sleep = pause,
  waitMs = 20000, pollMs = 50, onStage = () => {},
} = {}) {
  if (!path.isAbsolute(zylosDir) || !path.isAbsolute(homeDir)) throw error('INSTANCE_ROOT_INVALID', 'Absolute instance and home paths are required');
  zylosDir = fs.realpathSync(zylosDir);
  homeDir = fs.realpathSync(homeDir);
  let database = injectedDatabase, store = injectedStore, participant = injectedParticipant;
  let ownsDatabase = false, ownsParticipant = false;

  async function open() {
    if (!database) {
      const file = path.join(zylosDir, 'comm-bridge', 'c4.db');
      if (!fs.existsSync(file)) throw error('GROUP_DELETE_CORE_UNAVAILABLE', 'Core database is unavailable');
      database = new Database(file);
      try {
        guardDatabase(database, schema);
        database.pragma('journal_mode = WAL');
        database.pragma('busy_timeout = 5000');
        database.pragma('foreign_keys = ON');
        ownsDatabase = true;
      } catch (cause) { database.close(); database = null; throw cause; }
    }
    store ??= createStore(database);
    if (!participant) {
      if (!fs.existsSync(path.join(zylosDir, 'components', 'dashboard', 'dashboard.db'))) {
        participant = {
          resolveTarget(target) {
            if (!target.sessionGroup) throw error('chat_conversation_not_found', 'Draft is unavailable');
            return { sessionGroup: target.sessionGroup, draft: false };
          },
          preview: () => ({ attachments: 0, files: 0 }), finalizeTranscripts: () => {},
          cleanup({ removeGroupSources, onFilePhase }) { onFilePhase?.(); removeGroupSources?.(); return { attachments: 0, files: 0 }; }, close() {},
        };
      } else {
        const module = await import(pathToFileURL(path.join(zylosDir, '.claude', 'skills', 'dashboard', 'src', 'lib', 'group-deletion-storage.js')).href);
        participant = module.createGroupDeletionStorage({ zylosDir, homeDir, c4Db: database });
      }
      ownsParticipant = true;
    }
  }

  function messages(group, cutoffId = Number.MAX_SAFE_INTEGER) {
    return database.prepare(`SELECT id,direction,status,channel,endpoint_id,session_id FROM conversations
      WHERE session_group=? AND id<=? ORDER BY id`).all(group, cutoffId);
  }

  function paths(group, rows, keepGroupSources = false) {
    const roots = keepGroupSources ? [] : [
      [path.join(zylosDir, 'memory', 'session-groups'), groupMemoryDir(group, { ZYLOS_DIR: zylosDir })],
      [path.join(zylosDir, 'activity-monitor', 'session-groups'), groupRunDir(group, { ZYLOS_DIR: zylosDir })],
    ];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || row.id < 1) throw error('GROUP_DELETE_RECORD_INVALID', 'Invalid conversation identifier');
      const base = path.join(zylosDir, 'comm-bridge', 'attachments');
      roots.push([base, path.join(base, `conv-${row.id}`)]);
    }
    return roots;
  }

  const keyOf = resolved => JSON.stringify(resolved.sessionGroup ? ['group', resolved.sessionGroup] : ['draft', resolved.namespace, resolved.localId]);
  function retained(group, cutoffId) {
    return database.prepare("SELECT id FROM conversations WHERE session_group=? AND (id>? OR direction='in' AND status IN ('pending','running')) ORDER BY id").all(group, cutoffId).map(row => row.id);
  }
  async function preview(value) {
    const target = targetOf(value);
    await open();
    const resolved = await participant.resolveTarget(target);
    const targetKey = keyOf(resolved);
    const boundary = store.getDeletionPreviewBoundary(targetKey);
    const group = resolved.sessionGroup;
    const kept = group ? retained(group, boundary.cutoffId) : [];
    const extra = await participant.preview({ ...resolved, ...boundary, targetKey, hasRetainedMessages: kept.length > 0 });
    const rows = group ? messages(group, boundary.cutoffId) : [];
    const files = (extra.files ?? 0) + (group ? paths(group, rows, kept.length > 0).reduce((n, [base, file]) => n + countFiles(base, file), 0) : 0);
    return { ok: true, ...resolved, ...boundary, draft: !!resolved.draft, messages: rows.length, attachments: extra.attachments ?? 0,
      files, operationId: boundary.operationId ?? uuid() };
  }

  function completed(target, operationId) {
    if (!operationId) return null;
    const audit = store.getGroupDeletionAudit(operationId);
    if (!audit) return null;
    const dashboardNamespace = target.draftLocalId === undefined ? null : database.prepare(
      "SELECT namespace FROM channel_namespaces WHERE component_name='dashboard'"
    ).get()?.namespace;
    const matches = target.sessionGroup !== undefined ? audit.sessionGroup === target.sessionGroup :
      audit.draftLocalId === target.draftLocalId || Boolean(dashboardNamespace &&
        audit.sessionGroup === `${dashboardNamespace}:${target.draftLocalId}`);
    if (!matches) throw error('DELETION_OWNERSHIP_MISMATCH', 'Deletion operation belongs to another conversation');
    return audit.status === 'done' ? { ok: true, pending: false, operationId, counts: audit.counts, countsEstimated: audit.countsEstimated,
      retainedMessages: audit.retainedMessages, groupDataRetained: audit.groupDataRetained } : null;
  }

  function withCleanupAttempt(operationId, finalize) {
    store.markDeletionCleanup(operationId);
    let filePhase = false;
    try { return finalize(() => { filePhase = true; }); }
    catch (cause) {
      // The durable marker survives a killed process. A known pre-file failure
      // can retract only this attempt after the final writer has rolled back.
      if (!filePhase) store.retractDeletionCleanup(operationId);
      if (cause.cause?.status || cause.cause?.statusCode) throw cause.cause;
      throw cause;
    }
  }

  async function deleteConversation(value, { confirmed = false, actor, operationId, cutoffId } = {}) {
    const deadlineAt = now() + waitMs;
    const target = targetOf(value);
    if (confirmed !== true) throw error('CONFIRMATION_REQUIRED', 'Confirm the irreversible deletion before continuing');
    if (typeof actor !== 'string' || !actor || actor.length > 512) throw error('INVALID_ARGUMENT', 'A deletion actor is required');
    if (operationId !== undefined && (typeof operationId !== 'string' || !operationId || operationId.length > 512)) throw error('INVALID_ARGUMENT', 'Invalid deletion operation');
    await open();
    const known = operationId ? store.getGroupDeletionAudit(operationId) : null;
    if (known) {
      if (cutoffId !== undefined && cutoffId !== known.cutoffId) throw error('DELETION_OWNERSHIP_MISMATCH', 'Confirmed deletion boundary does not match');
      cutoffId = known.cutoffId;
    } else if (!Number.isSafeInteger(cutoffId) || cutoffId < 0) {
      throw error('DELETION_CONFIRMATION_REQUIRED', 'Preview the conversation before confirming deletion');
    }
    const done = completed(target, operationId);
    if (done) return done;
    const resolved = await participant.resolveTarget(target);
    const targetKey = keyOf(resolved);
    const group = resolved.sessionGroup;
    if (target.draftLocalId !== undefined && cutoffId === 0 && group) throw error('DRAFT_BECAME_ACTIVE', 'The draft received a message; preview deletion again');
    const keptBefore = group ? retained(group, cutoffId) : [];
    const extra = await participant.preview({ ...resolved, cutoffId, targetKey, hasRetainedMessages: keptBefore.length > 0 });
    if (!group) {
      const audit = store.beginDraftDeletion(resolved.localId, { operationId: operationId ?? uuid(), actor, cutoffId, targetKey,
        preview: { messages: 0, attachments: extra.attachments ?? 0, files: extra.files ?? 0 } });
      if (audit.status === 'done') return { ok: true, pending: false, operationId: audit.operationId, counts: audit.counts, countsEstimated: audit.countsEstimated,
        retainedMessages: audit.retainedMessages, groupDataRetained: audit.groupDataRetained };
      const result = withCleanupAttempt(audit.operationId, onFilePhase => store.finalizeDraftDeletion(resolved.localId, { operationId: audit.operationId,
        cleanup: () => {
          const removed = participant.cleanup({ ...resolved, cutoffId, hasRetainedMessages: false, onFilePhase });
          onStage('files_removed', audit);
          return removed;
        } }));
      return { ok: true, pending: false, operationId: result.operationId, counts: result.counts, countsEstimated: result.countsEstimated,
        retainedMessages: result.retainedMessages, groupDataRetained: result.groupDataRetained };
    }

    const existing = store.getActiveDeletion(group);
    if (existing && operationId !== existing.operationId) throw error('DELETION_OWNERSHIP_MISMATCH', 'Another deletion owns this conversation');
    const requestId = operationId ?? uuid();
    const initialRows = messages(group, cutoffId);
    const initial = { messages: initialRows.length, attachments: extra.attachments ?? 0,
      files: (extra.files ?? 0) + paths(group, initialRows, keptBefore.length > 0).reduce((n, [base, file]) => n + countFiles(base, file), 0) };
    const admissionNow = now();
    const result = await requestStop({ version: 1, type: 'delete_group', requestId,
      operationId: requestId, sessionGroup: group, actor, preview: initial, cutoffId },
    { socketPath: path.join(zylosDir, 'activity-monitor', 'am.sock'),
      deadlineAt: Math.max(admissionNow + 1000, Math.min(deadlineAt, admissionNow + 10000)) });
    if (result.kind === 'rejected') throw error(result.reply?.reason ?? result.reply?.code ?? 'GROUP_DELETE_REJECTED', 'Core rejected deletion admission');
    const active = store.getActiveDeletion(group);
    if (!active) {
      const knownDone = completed(target, requestId);
      if (knownDone) return knownDone;
      return { ok: false, pending: result.sent === true, operationId: requestId,
        error: { code: result.sent ? 'GROUP_DELETE_RESULT_UNKNOWN' : 'GROUP_DELETE_SUPERVISOR_UNAVAILABLE', message: 'Supervisor admission could not be confirmed' } };
    }
    await onStage('fenced', active);
    let stopped = false;
    do {
      stopped = store.listRunEndings([group]).some(row => row.reason === 'delete' && row.runId === (active.runId ?? active.operationId));
      if (stopped) break;
      if (now() >= deadlineAt) return { ok: true, pending: true, operationId: active.operationId, reason: 'draining' };
      await sleep(Math.min(pollMs, Math.max(1, deadlineAt - now())));
    } while (true);
    await onStage('stopped', active);
    try { await participant.finalizeTranscripts({ ...resolved, cutoffId: active.cutoffId, hasRetainedMessages: retained(group, active.cutoffId).length > 0, processExited: true, deadlineAt, now }); }
    catch (cause) {
      if (cause.code === 'group_delete_usage_pending' || cause.code === 'GROUP_DELETE_USAGE_PENDING') {
        return { ok: true, pending: true, operationId: active.operationId, reason: 'usage_pending' };
      }
      throw cause;
    }
    if (now() >= deadlineAt) return { ok: true, pending: true, operationId: active.operationId, reason: 'usage_pending' };
    await onStage('usage_imported', active);
    const audit = withCleanupAttempt(active.operationId, onFilePhase => store.finalizeGroupDeletion(group, { operationId: active.operationId,
      cleanup: () => {
        // The Core writer lock also fences receives while Dashboard resolves
        // pending attachment links. Dashboard's writer serializes old imports.
        const toDelete = store.listDeletionMessages(group, { operationId: active.operationId });
        const hasRetainedMessages = retained(group, active.cutoffId).length > 0;
        const groupSources = paths(group, toDelete, hasRetainedMessages);
        for (const [base, file] of groupSources) countFiles(base, file);
        let removed = 0;
        const outcome = participant.cleanup({ ...resolved, cutoffId: active.cutoffId, hasRetainedMessages, onFilePhase,
          removeGroupSources: () => {
            for (const [base, file] of groupSources) removed += removeTree(base, file);
            onStage('files_removed', active);
          } });
        if (outcome?.then) throw error('GROUP_DELETE_ASYNC_CLEANUP', 'Cleanup must finish inside its writer transaction');
        return { attachments: outcome?.attachments ?? 0, files: removed + (outcome?.files ?? 0) };
      } }));
    return { ok: true, pending: false, operationId: audit.operationId, counts: audit.counts, countsEstimated: audit.countsEstimated,
      retainedMessages: audit.retainedMessages, groupDataRetained: audit.groupDataRetained };
  }

  return { preview, delete: deleteConversation, close() {
    if (ownsParticipant) participant?.close();
    if (ownsDatabase) database?.close();
    participant = injectedParticipant; database = injectedDatabase; store = injectedStore;
    ownsParticipant = ownsDatabase = false;
  } };
}
