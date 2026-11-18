#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from './sqlite-driver.js';
import { guardDatabase } from './sqlite-schema.js';
import * as schema from './c4-schema.js';
import { loadCoreModule } from './router/core-modules.js';

const REASONS = ['launch_failed', 'ready_timeout', 'delivery_failed',
  'delivery_unverified', 'pending_expired', 'orphan_expired', 'orphan_retry_exhausted'];
const PHASES = ['preflight', 'new_session', 'executor_init', 'exec_confirm', 'runtime_ready'];
const CAUSES = ['timeout', 'ready_timeout', 'launch_failed', 'LAUNCH_FAILED', 'RUNTIME_NOT_INSTALLED', 'MODEL_CONFIG_REJECTED'];
const DURATIONS = ['preflight_ms', 'new_session_ms', 'executor_init_ms', 'exec_confirm_ms', 'cleanup_ms', 'total_ms', 'timeout_ms'];
const safeText = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512) : null;
const positiveId = value => /^(?:[1-9][0-9]*)$/.test(String(value)) && Number.isSafeInteger(Number(value));
const failure = code => Object.assign(new Error(code), { code });

/** Reuse the Core reader for timestamp rotations and incomplete-line handling.
 * Retain only twenty matching events; cap scanning without buffering history. */
export async function readLaunchFailures(id, filename) {
  const { EventLogReader } = await loadCoreModule('event-log.js');
  const reader = new EventLogReader(filename);
  let scanned = 0, matched = 0;
  try {
    const events = reader.recoverTail(row => {
      const keep = row.event === 'session_launch_failed' && row.conversation_id === id;
      scanned++; if (keep) matched++;
      return { keep, done: matched >= 20 || scanned >= 10000 };
    }).map(row => {
      const result = { event: 'session_launch_failed', conversation_id: id,
        last_phase: PHASES.includes(row.last_phase) ? row.last_phase : null,
        cause: CAUSES.includes(row.cause) ? row.cause : null };
      for (const key of [...DURATIONS, 'attempt', 'ts']) {
        if (Number.isFinite(row[key]) && row[key] >= 0) result[key] = row[key];
      }
      if (typeof row.run_id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(row.run_id)) result.run_id = row.run_id;
      return result;
    });
    return { events, limited: matched >= 20 || scanned >= 10000 };
  } finally { reader.close(); }
}

/** Owner-authorized diagnostics only. Never select conversation bodies, raw
 * exceptions, environment, launch configuration or another group's history. */
export async function diagnoseMessage(id, { connection, env = process.env, reader, readMode, logFile } = {}) {
  if (!positiveId(id)) throw failure('INVALID_ARGS');
  id = Number(id);
  const { zylosRoot, routerDiagnosticPath } = await loadCoreModule('session-group-paths.js');
  let owned;
  try {
    const db = connection ?? (owned = new Database(path.join(zylosRoot(env), 'comm-bridge', 'c4.db'),
      { readonly: true, fileMustExist: true, timeout: 3000 }));
    guardDatabase(db, schema, { readonly: true });
    const row = db.prepare(`SELECT c.id,c.status,c.retry_count,c.channel,c.endpoint_id,c.session_group,c.core_source,c.task_name,
      f.reason,f.state AS alert_state FROM conversations c LEFT JOIN failure_receipts f ON f.conversation_id=c.id WHERE c.id=?`).get(id);
    if (!row) throw failure('NOT_FOUND');
    const message = { id, status: ['pending', 'running', 'delivered', 'failed', 'switch_absorbed'].includes(row.status) ? row.status : null, retry_count: row.retry_count,
      channel: safeText(row.channel), endpoint: safeText(row.endpoint_id), session_group: safeText(row.session_group),
      source: row.channel === 'internal' ? 'internal' : row.core_source === 'scheduler' ? 'scheduler' : 'user',
      task_name: safeText(row.task_name), reason: REASONS.includes(row.reason) ? row.reason : null,
      alert_state: row.alert_state ?? null };
    let target;
    try {
      const mode = (readMode ?? (await loadCoreModule('config.js')).readSessionMode)().mode;
      if (!['single', 'multi'].includes(mode)) throw failure('CONFIG_UNREADABLE');
      const sessionGroup = mode === 'single' ? null : row.session_group;
      const current = await (reader ?? (await loadCoreModule('session-state-reader-async.js')).createSessionReader({ env }))
        .readSessionState(sessionGroup, { freshnessMs: 5000 });
      const uncertain = Boolean(current.observationError);
      const valid = !uncertain && current.status.valid === true;
      target = { observation: uncertain ? 'unknown' : 'observed', mode,
        session_group: sessionGroup ?? 'origin', present: uncertain ? null : current.identity.present,
        ready: uncertain ? null : current.identity.ready,
        runtime: !uncertain && ['claude', 'codex'].includes(current.identity.runtime) ? current.identity.runtime : 'unknown',
        status_valid: valid,
        state: valid && ['idle', 'busy', 'unknown'].includes(current.status.value?.state) ? current.status.value.state : null,
        health: valid && ['ok', 'auth_failed', 'rate_limited', 'unavailable', 'recovering', 'down'].includes(current.status.value?.health) ? current.status.value.health : null };
    } catch { target = { observation: 'unknown', present: null, ready: null, status_valid: false }; }
    let launch;
    try { launch = await readLaunchFailures(id, logFile ?? routerDiagnosticPath(env)); }
    catch { launch = { events: [], limited: false, unavailable: true }; }
    return { message, launch_failures: launch, target };
  } finally { owned?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('Owner-only read-only diagnostics: c4-diagnose.js --id ID\n');
  } else {
    try {
      if (args.length !== 2 || args[0] !== '--id') throw failure('INVALID_ARGS');
      const data = await diagnoseMessage(args[1]);
      process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
    } catch (error) {
      const code = ['INVALID_ARGS', 'NOT_FOUND'].includes(error.code) ? error.code : 'DIAGNOSTIC_UNAVAILABLE';
      process.stdout.write(JSON.stringify({ ok: false, error: { code } }) + '\n');
      process.exitCode = 1;
    }
  }
}
