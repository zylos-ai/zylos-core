/**
 * Multi-Session Worker Registry
 *
 * Persistent JSON store mapping agent-teams workers (teammates) to zylos
 * tasks, delivery directories, status, and usage notes. Survives main-session
 * molt (/clear) — the registry is the source of truth for "what work was
 * delegated and where the artifacts live".
 *
 * Data goes to ~/zylos/multi-session/, code stays in skills directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const DATA_DIR = path.join(ZYLOS_DIR, 'multi-session');
export const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');
export const DELIVERIES_DIR = path.join(DATA_DIR, 'deliveries');

/** All valid worker statuses. */
export const STATUSES = ['pending', 'running', 'done', 'accepted', 'failed', 'reassigned'];

/** Statuses that count against the concurrency cap (worker may be consuming a teammate slot). */
export const ACTIVE_STATUSES = ['pending', 'running'];

/** Statuses considered "in flight" for harvest purposes: not yet accepted/closed. */
export const IN_FLIGHT_STATUSES = ['pending', 'running', 'done'];

/** Hard cap on concurrent workers (prior decision 2026-06-09; v2.1 §3). */
export const MAX_ACTIVE_WORKERS = 2;

export function generateId() {
  return `worker-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Load the registry. Returns { workers: [] } when the file does not exist.
 * Throws on corrupt JSON (fail loudly rather than silently dropping records).
 */
export function loadRegistry(registryPath = REGISTRY_PATH) {
  if (!fs.existsSync(registryPath)) {
    return { workers: [] };
  }
  const raw = fs.readFileSync(registryPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.workers)) {
    throw new Error(`Corrupt registry at ${registryPath}: missing "workers" array`);
  }
  return data;
}

/**
 * Atomically persist the registry: write to a temp file in the same
 * directory, then rename over the target. A crash mid-write can never leave
 * a truncated registry.json behind.
 */
export function saveRegistry(data, registryPath = REGISTRY_PATH) {
  const dir = path.dirname(registryPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.registry-${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, registryPath);
}

function assertStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Valid: ${STATUSES.join(', ')}`);
  }
}

/**
 * Add a worker entry. Required: task (description). Optional: team,
 * teammate, deliveryDir, status (default "pending"), usage, resultSummary,
 * predecessorId (set when reassigning).
 */
export function addWorker(fields, registryPath = REGISTRY_PATH) {
  if (!fields || !fields.task) {
    throw new Error('addWorker requires a "task" description');
  }
  const status = fields.status || 'pending';
  assertStatus(status);
  const ts = now();
  const worker = {
    id: fields.id || generateId(),
    team: fields.team || null,
    teammate: fields.teammate || null,
    task: fields.task,
    deliveryDir: fields.deliveryDir || null,
    status,
    createdAt: ts,
    updatedAt: ts,
    usage: fields.usage || null,
    resultSummary: fields.resultSummary || null,
    predecessorId: fields.predecessorId || null,
  };
  const data = loadRegistry(registryPath);
  if (data.workers.some((w) => w.id === worker.id)) {
    throw new Error(`Worker id already exists: ${worker.id}`);
  }
  data.workers.push(worker);
  saveRegistry(data, registryPath);
  return worker;
}

export function getWorker(id, registryPath = REGISTRY_PATH) {
  return loadRegistry(registryPath).workers.find((w) => w.id === id) || null;
}

const UPDATABLE_FIELDS = new Set(['team', 'teammate', 'task', 'deliveryDir', 'status', 'usage', 'resultSummary']);

export function updateWorker(id, fields, registryPath = REGISTRY_PATH) {
  const data = loadRegistry(registryPath);
  const worker = data.workers.find((w) => w.id === id);
  if (!worker) {
    throw new Error(`Worker not found: ${id}`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!UPDATABLE_FIELDS.has(key)) {
      throw new Error(`Field not updatable: ${key}`);
    }
    if (key === 'status') assertStatus(value);
    worker[key] = value;
  }
  worker.updatedAt = now();
  saveRegistry(data, registryPath);
  return worker;
}

export function listWorkers({ statuses } = {}, registryPath = REGISTRY_PATH) {
  const workers = loadRegistry(registryPath).workers;
  if (!statuses) return workers;
  return workers.filter((w) => statuses.includes(w.status));
}

/** Workers currently counting against the concurrency cap. */
export function activeWorkers(registryPath = REGISTRY_PATH) {
  return listWorkers({ statuses: ACTIVE_STATUSES }, registryPath);
}

/** Workers not yet accepted/closed — must be harvested before molt. */
export function inFlightWorkers(registryPath = REGISTRY_PATH) {
  return listWorkers({ statuses: IN_FLIGHT_STATUSES }, registryPath);
}
