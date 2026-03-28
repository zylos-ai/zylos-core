import { getDb, generateWorkId, nowSeconds } from './db.js';

const VALID_SOURCE_SYSTEMS = new Set(['conversation', 'control', 'scheduler', 'component', 'memory']);
const VALID_KINDS = new Set(['human_message', 'control_message', 'scheduled_task', 'component_op', 'memory_sync']);
const VALID_STATES = new Set([
  'queued',
  'running',
  'waiting_user',
  'waiting_external',
  'done',
  'failed',
  'timeout',
  'cancelled'
]);

const TERMINAL_STATES = new Set(['done', 'failed', 'timeout', 'cancelled']);

const ALLOWED_TRANSITIONS = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['waiting_user', 'waiting_external', 'done', 'failed', 'timeout', 'cancelled']),
  waiting_user: new Set(['running', 'cancelled', 'timeout']),
  waiting_external: new Set(['running', 'cancelled', 'timeout']),
  done: new Set(),
  failed: new Set(),
  timeout: new Set(),
  cancelled: new Set()
};

function ensureWorkExists(workId) {
  const work = getWork(workId);
  if (!work) {
    throw new Error(`Work not found: ${workId}`);
  }
  return work;
}

function parseJsonSafe(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeJsonText(value, fallbackText) {
  if (value === undefined || value === null) {
    return fallbackText;
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function parseWorkRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    artifact_refs: parseJsonSafe(row.artifact_refs, []),
    closeout_json: parseJsonSafe(row.closeout_json, null)
  };
}

function parseEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    event_json: parseJsonSafe(row.event_json, null)
  };
}

export function createWork(input) {
  const sourceSystem = input?.sourceSystem;
  const sourceId = input?.sourceId;
  const kind = input?.kind;

  if (!VALID_SOURCE_SYSTEMS.has(sourceSystem)) {
    throw new Error(`Invalid sourceSystem: ${sourceSystem}`);
  }
  if (!sourceId) {
    throw new Error('sourceId is required');
  }
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid kind: ${kind}`);
  }

  const state = input?.state || 'queued';
  if (!VALID_STATES.has(state)) {
    throw new Error(`Invalid state: ${state}`);
  }

  const priority = input?.priority ?? 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    throw new Error(`Invalid priority: ${priority}`);
  }

  const timestamp = nowSeconds();
  const workId = input?.workId || generateWorkId();
  const artifactRefsText = normalizeJsonText(input?.artifactRefs, '[]');

  const db = getDb();
  db.prepare(`
    INSERT INTO runtime_work (
      work_id, source_system, source_id, source_run_id, kind, state, priority, summary, subject,
      channel, endpoint_id, reply_channel, reply_endpoint, require_idle, parent_work_id,
      lease_owner, lease_acquired_at, lease_expires_at, active_session,
      waiting_reason, waiting_on, closeout_status, closeout_summary, closeout_json, artifact_refs,
      error_code, error_detail, created_at, updated_at, started_at, finished_at
    ) VALUES (
      @workId, @sourceSystem, @sourceId, @sourceRunId, @kind, @state, @priority, @summary, @subject,
      @channel, @endpointId, @replyChannel, @replyEndpoint, @requireIdle, @parentWorkId,
      @leaseOwner, @leaseAcquiredAt, @leaseExpiresAt, @activeSession,
      @waitingReason, @waitingOn, @closeoutStatus, @closeoutSummary, @closeoutJson, @artifactRefs,
      @errorCode, @errorDetail, @createdAt, @updatedAt, @startedAt, @finishedAt
    )
  `).run({
    workId,
    sourceSystem,
    sourceId,
    sourceRunId: input?.sourceRunId || null,
    kind,
    state,
    priority,
    summary: input?.summary || null,
    subject: input?.subject || null,
    channel: input?.channel || null,
    endpointId: input?.endpointId || null,
    replyChannel: input?.replyChannel || null,
    replyEndpoint: input?.replyEndpoint || null,
    requireIdle: input?.requireIdle ? 1 : 0,
    parentWorkId: input?.parentWorkId || null,
    leaseOwner: input?.leaseOwner || null,
    leaseAcquiredAt: input?.leaseAcquiredAt || null,
    leaseExpiresAt: input?.leaseExpiresAt || null,
    activeSession: input?.activeSession || null,
    waitingReason: input?.waitingReason || null,
    waitingOn: input?.waitingOn || null,
    closeoutStatus: input?.closeoutStatus || null,
    closeoutSummary: input?.closeoutSummary || null,
    closeoutJson: normalizeJsonText(input?.closeoutJson, null),
    artifactRefs: artifactRefsText,
    errorCode: input?.errorCode || null,
    errorDetail: input?.errorDetail || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: input?.startedAt || null,
    finishedAt: input?.finishedAt || null
  });

  appendEvent(workId, 'created', {
    sourceSystem,
    sourceId,
    kind,
    state,
    priority
  });

  return getWork(workId);
}

export function transitionWork(workId, patch) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('patch object is required');
  }

  const current = ensureWorkExists(workId);
  const nextState = patch.state ?? current.state;

  if (!VALID_STATES.has(nextState)) {
    throw new Error(`Invalid state: ${nextState}`);
  }

  if (nextState !== current.state && !ALLOWED_TRANSITIONS[current.state].has(nextState)) {
    throw new Error(`Invalid state transition: ${current.state} -> ${nextState}`);
  }

  const updateFields = ['state = @state', 'updated_at = @updatedAt'];
  const params = {
    workId,
    state: nextState,
    updatedAt: nowSeconds()
  };

  const writableFields = [
    ['summary', 'summary'],
    ['subject', 'subject'],
    ['waitingReason', 'waiting_reason'],
    ['waitingOn', 'waiting_on'],
    ['errorCode', 'error_code'],
    ['errorDetail', 'error_detail'],
    ['leaseOwner', 'lease_owner'],
    ['leaseAcquiredAt', 'lease_acquired_at'],
    ['leaseExpiresAt', 'lease_expires_at'],
    ['activeSession', 'active_session']
  ];

  for (const [inputKey, columnName] of writableFields) {
    if (Object.hasOwn(patch, inputKey)) {
      updateFields.push(`${columnName} = @${inputKey}`);
      params[inputKey] = patch[inputKey];
    }
  }

  if (Object.hasOwn(patch, 'priority')) {
    if (!Number.isInteger(patch.priority) || patch.priority < 1 || patch.priority > 3) {
      throw new Error(`Invalid priority: ${patch.priority}`);
    }
    updateFields.push('priority = @priority');
    params.priority = patch.priority;
  }

  if (nextState !== current.state && nextState === 'running' && !current.started_at) {
    updateFields.push('started_at = @startedAt');
    params.startedAt = params.updatedAt;
  }

  if (nextState !== current.state && TERMINAL_STATES.has(nextState)) {
    updateFields.push('finished_at = @finishedAt');
    params.finishedAt = params.updatedAt;
  }

  const db = getDb();
  db.prepare(`
    UPDATE runtime_work
    SET ${updateFields.join(', ')}
    WHERE work_id = @workId
  `).run(params);

  appendEvent(workId, 'state_transition', {
    from: current.state,
    to: nextState,
    patch
  });

  return getWork(workId);
}

export function appendEvent(workId, eventType, eventPayload = null) {
  if (!eventType) {
    throw new Error('eventType is required');
  }

  ensureWorkExists(workId);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO runtime_work_event (work_id, event_type, event_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    workId,
    eventType,
    normalizeJsonText(eventPayload, null),
    nowSeconds()
  );

  return Number(result.lastInsertRowid);
}

export function closeOut(workId, payload = {}) {
  const current = ensureWorkExists(workId);
  const status = payload.status || payload.closeoutStatus || current.closeout_status || 'done';
  if (!TERMINAL_STATES.has(status)) {
    throw new Error(`closeOut status must be terminal: ${status}`);
  }

  const timestamp = nowSeconds();
  const closeoutSummary = payload.summary ?? payload.closeoutSummary ?? null;
  const closeoutJson = normalizeJsonText(payload.closeoutJson ?? payload.payload, null);
  const artifactRefs = normalizeJsonText(payload.artifactRefs, current.artifact_refs || []);

  const db = getDb();
  db.prepare(`
    UPDATE runtime_work
    SET state = @state,
        closeout_status = @closeoutStatus,
        closeout_summary = @closeoutSummary,
        closeout_json = @closeoutJson,
        artifact_refs = @artifactRefs,
        error_code = @errorCode,
        error_detail = @errorDetail,
        updated_at = @updatedAt,
        finished_at = @finishedAt
    WHERE work_id = @workId
  `).run({
    workId,
    state: status,
    closeoutStatus: status,
    closeoutSummary,
    closeoutJson,
    artifactRefs,
    errorCode: payload.errorCode ?? current.error_code ?? null,
    errorDetail: payload.errorDetail ?? current.error_detail ?? null,
    updatedAt: timestamp,
    finishedAt: timestamp
  });

  appendEvent(workId, 'close_out', {
    status,
    summary: closeoutSummary,
    errorCode: payload.errorCode ?? null
  });

  return getWork(workId);
}

export function getWork(workId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM runtime_work WHERE work_id = ?').get(workId);
  return parseWorkRow(row);
}

export function listWork(options = {}) {
  const state = options.state || null;
  const limit = Number.isInteger(options.limit) ? options.limit : 50;
  const safeLimit = Math.min(Math.max(limit, 1), 200);

  const db = getDb();
  const rows = state
    ? db.prepare(`
        SELECT * FROM runtime_work
        WHERE state = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(state, safeLimit)
    : db.prepare(`
        SELECT * FROM runtime_work
        ORDER BY created_at DESC
        LIMIT ?
      `).all(safeLimit);

  return rows.map(parseWorkRow);
}

export function getWorkEvents(workId, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 200;
  const safeLimit = Math.min(Math.max(limit, 1), 1000);

  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM runtime_work_event
    WHERE work_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(workId, safeLimit);

  return rows.map(parseEventRow);
}
