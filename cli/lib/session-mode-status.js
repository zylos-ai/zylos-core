import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { ZYLOS_DIR, readSessionMode } from './config.js';
import { supervisorDiagnosticPath } from './session-group-paths.js';
import { EventLogReader } from './event-log.js';

const transitionEvent = event => typeof event === 'string'
  && (event.startsWith('transition_') || event.startsWith('auto_migration_') || event === 'absorb');
const errorView = error => ({ code: error.code ?? 'READ_FAILED', message: error.message ?? String(error) });

/** Observe reachability without submitting even a read request to the supervisor. */
export function probeSupervisor(socketPath, { connect = net.createConnection, timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    let socket, timer, finished = false;
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket?.destroy(); resolve(value);
    };
    timer = setTimeout(() => finish(false), Math.min(1000, Math.max(1, timeoutMs)));
    try {
      socket = connect(socketPath);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    } catch { finish(false); }
  });
}

function pm2Package(env) {
  const require = createRequire(import.meta.url);
  try { return path.dirname(require.resolve('pm2/package.json')); }
  catch {
    for (const directory of (env.PATH ?? '').split(path.delimiter)) {
      if (!directory) continue;
      try {
        const executable = fs.realpathSync(path.join(directory, 'pm2'));
        const root = path.dirname(path.dirname(executable));
        if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'pm2') return root;
      } catch { /* Continue to the next installed CLI. */ }
    }
    throw Object.assign(new Error('Installed PM2 transport is unavailable'), { code: 'PM2_UNAVAILABLE' });
  }
}

/** Read an existing PM2 daemon directly; never launch one as `pm2 jlist` can. */
export async function readSupervisorPm2({ env = process.env, timeoutMs = 1000 } = {}) {
  const root = pm2Package(env), require = createRequire(path.join(root, 'package.json'));
  const axon = require('./modules/pm2-axon');
  const rpc = require('./modules/pm2-axon-rpc');
  const socketPath = env.PM2_RPC_PORT || path.join(env.PM2_HOME || path.join(env.HOME || os.homedir(), '.pm2'), 'rpc.sock');
  const rows = await new Promise((resolve, reject) => {
    const socket = axon.socket('req'), client = new rpc.Client(socket);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('PM2 observation timed out'), { code: 'ETIMEDOUT' })), Math.min(1000, Math.max(1, timeoutMs)));
    socket.once('error', error => finish(error));
    socket.once('reconnect attempt', () => finish(Object.assign(new Error('PM2 daemon is not reachable'), { code: 'ECONNREFUSED' })));
    socket.once('connect', () => client.call('getMonitorData', {}, finish));
    try { socket.connect(socketPath); } catch (error) { finish(error); }
  });
  if (!Array.isArray(rows)) throw new TypeError('PM2 did not return a process list');
  const process = rows.find(row => row.name === 'activity-monitor');
  if (!process) return 'not_found';
  if (typeof process.pm2_env?.status !== 'string') throw new TypeError('PM2 process status is unavailable');
  return process.pm2_env.status;
}

async function openReadStore(zylosDir) {
  const [{ default: Database }, { createStore }, schema, { guardDatabase, assertCoreDatabaseAvailable }] = await Promise.all([
    import('better-sqlite3'),
    import('../../skills/comm-bridge/scripts/c4-v2-store.js'),
    import('../../skills/comm-bridge/scripts/c4-schema.js'),
    import('../../skills/comm-bridge/scripts/sqlite-schema.js'),
  ]);
  assertCoreDatabaseAvailable(zylosDir);
  const connection = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'), { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    guardDatabase(connection, schema, { readonly: true });
    return { store: createStore(connection), close: () => connection.close() };
  } catch (error) { connection.close(); throw error; }
}

function readEvents(zylosDir) {
  const reader = new EventLogReader(supervisorDiagnosticPath({ ZYLOS_DIR: zylosDir }));
  try { return reader.read(); }
  finally { reader.close(); }
}

function transitionView(row) {
  return row === null ? null : {
    runId: row.run_id, sourceMode: row.source_mode, targetMode: row.target_mode,
    phase: row.phase, cutoff: row.cutoff, reason: row.reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Read authoritative state independently of M4. Diagnostics affect display fields only. */
export async function readSessionModeStatus(options = {}) {
  const zylosDir = options.zylosDir ?? ZYLOS_DIR;
  let sessionMode;
  try { sessionMode = (await (options.readMode ?? readSessionMode)()).mode; }
  catch { sessionMode = 'unreadable'; }

  let owned;
  const db = options.db ?? (owned = await openReadStore(zylosDir)).store;
  let row, fence, completed;
  try {
    // Do not convert any C4 failure into absence. These are the P01 query APIs.
    row = await db.getModeTransition();
    fence = await db.getDrainFence('*');
    completed = await db.getLastCompletedModeTransition();
  } finally { owned?.close(); }
  const transition = transitionView(row);
  const lastCompleted = completed === null ? null : {
    runId: completed.run_id, sourceMode: completed.source_mode,
    targetMode: completed.target_mode, updatedAt: completed.updated_at,
  };
  const globalGate = { present: fence !== null, reason: fence?.reason ?? null, runId: fence?.runId ?? null };
  const runId = transition?.runId ?? lastCompleted?.runId;
  let events = [];
  if (runId) {
    try {
      events = (await (options.readEvents ?? readEvents)(zylosDir))
        .filter(event => event.run_id === runId && transitionEvent(event.event));
    } catch { /* Missing/unreadable diagnostics never hide authoritative state. */ }
  }
  const blocked = transition?.reason ? {
    reason: transition.reason,
    since: events.find(event => event.reason === transition.reason && Number.isFinite(event.ts))?.ts ?? null,
  } : null;
  const lastEvents = events.slice(-10);
  let reachable = false;
  try { reachable = await (options.probeSupervisor ?? probeSupervisor)(path.join(zylosDir, 'activity-monitor', 'am.sock')); }
  catch { /* Observation failures are explicitly unreachable. */ }
  const result = { sessionMode, transition, globalGate, blocked, lastEvents,
    supervisor: reachable ? 'reachable' : 'unreachable', lastCompleted };
  if (!reachable) {
    // IB-44 requires the PM2 observation alongside unreachable; this additive
    // display field never replaces D9, the global gate or socket reachability.
    try { result.supervisorPm2 = { status: await (options.readPm2 ?? readSupervisorPm2)(), error: null }; }
    catch (error) { result.supervisorPm2 = { status: 'unobservable', error: errorView(error) }; }
  }
  return result;
}

export function formatSessionModeStatus(data) {
  const mode = data.sessionMode === null ? 'unset (effective single)' : data.sessionMode;
  const lines = [`Session mode: ${mode}`, `Supervisor: ${data.supervisor}`];
  if (data.supervisorPm2) lines.push(`PM2 activity-monitor: ${data.supervisorPm2.status}${data.supervisorPm2.error ? ` (${data.supervisorPm2.error.message})` : ''}`);
  lines.push(`Global gate: ${data.globalGate.present ? 'present' : 'absent'}`);
  if (data.transition) {
    const row = data.transition;
    lines.push(`Transition: ${row.runId} ${row.sourceMode} -> ${row.targetMode} (${row.phase})`);
  } else lines.push('Transition: none');
  if (data.blocked) lines.push(`Blocked: ${data.blocked.reason}${data.blocked.since === null ? '' : ` (since ${data.blocked.since})`}`);
  if (data.lastCompleted) lines.push(`Last completed: ${data.lastCompleted.runId} ${data.lastCompleted.sourceMode} -> ${data.lastCompleted.targetMode} (${data.lastCompleted.updatedAt})`);
  return lines.join('\n');
}
