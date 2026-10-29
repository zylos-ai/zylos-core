import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { privateParents } from './observer-tmux-state.js';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createObserverContainment } from './observer-containment.js';
import { ObserverCoordinator } from './observer-coordinator.js';
import { ObserverInstaller } from './observer-installer.js';
import { observerPaths } from './observer-paths.js';

const MAX_MESSAGE_BYTES = 4 * 1024;
const CONNECT_TIMEOUT_MS = 2_000;
const OPERATION_TIMEOUT_MS = 15_000;
async function acquireCoordinatorLock(controlRoot, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const trustedData = await fs.promises.realpath(path.resolve(controlRoot, '../../..'));
  controlRoot = path.join(trustedData, 'observer', 'runtime', 'control');
  await privateParents(controlRoot);
  await fs.promises.mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.promises.lstat(controlRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) ||
      directory.uid !== process.getuid()) throw new Error('Unsafe Observer control directory');
  // Legacy producers use a different lock protocol. Never reap their state while
  // switching protocols: even an unreadable owner is not evidence of absence.
  try {
    await fs.promises.lstat(path.join(controlRoot, 'coordinator.lock'));
    throw Object.assign(new Error('Legacy Observer lock requires recovery'), { code: 'legacy_coordinator_lock' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lockPath = path.join(controlRoot, 'coordinator-lock.sqlite');
  for (const file of [lockPath, `${lockPath}-journal`, `${lockPath}-wal`, `${lockPath}-shm`]) {
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
        throw new Error('Unsafe Observer lock file');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Create privately before SQLite opens it. The inode is permanent, including
  // after uninstall, so all contenders always lock the same database.
  try { const fd = await fs.promises.open(lockPath, 'wx', 0o600); await fd.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const database = new Database(lockPath, { timeout: 0 });
  const deadline = Date.now() + timeoutMs;
  try {
    do {
      try {
        database.exec('BEGIN EXCLUSIVE');
        return { lockPath, async release() { if (database.open) { database.exec('ROLLBACK'); database.close(); } } };
      } catch (error) {
        if (error.code !== 'SQLITE_BUSY') throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } while (Date.now() <= deadline);
    throw Object.assign(new Error('Observer coordinator is already active'), { code: 'coordinator_active' });
  } catch (error) { database.close(); throw error; }
}

function controlSocketPath(dataDir) {
  const key = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 20);
  return path.join('/tmp', `zobs-ctl-${key}.sock`);
}

function readLine(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Observer control timeout')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Observer control closed')); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_MESSAGE_BYTES) { cleanup(); reject(new Error('Observer control message too large')); return; }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

export class ObserverControlServer {
  constructor({ dataDir, onPreUninstall }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.onPreUninstall = onPreUninstall;
    this.socketPath = controlSocketPath(this.dataDir);
    this.server = null;
    this.lock = null;
    this._starting = null;
    this._acquiring = null;
  }

  async acquire() {
    if (this.lock) return;
    if (!this._acquiring) this._acquiring = acquireCoordinatorLock(observerPaths(this.dataDir).control)
      .then((lock) => { this.lock = lock; }).finally(() => { this._acquiring = null; });
    return this._acquiring;
  }

  async start() {
    if (this.server) return;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      await this.acquire();
      try {
        try { await fs.promises.unlink(this.socketPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        this.server = net.createServer((socket) => {
          readLine(socket, CONNECT_TIMEOUT_MS).then(async (message) => {
            if (message?.action !== 'pre-uninstall' || Object.keys(message).length !== 1) {
              throw Object.assign(new Error('invalid control action'), { code: 'invalid_action' });
            }
            await this.onPreUninstall();
            socket.end(`${JSON.stringify({ ok: true })}\n`);
          }).catch((error) => {
            if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: error.code || 'control_failed' })}\n`);
          });
        });
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(this.socketPath, resolve);
        });
        await fs.promises.chmod(this.socketPath, 0o600);
      } catch (error) {
        try { this.server?.close(); } catch {}
        this.server = null;
        // Socket publication failure must not relinquish lifecycle ownership.
        // Recovery can retry publication; shutdown releases after cleanup.
        throw error;
      }
    })().finally(() => { this._starting = null; });
    return this._starting;
  }

  async close() {
    if (this._acquiring) { try { await this._acquiring; } catch { return; } }
    if (this._starting) {
      try { await this._starting; } catch { /* Release retained ownership below. */ }
    }
    // A failed contender must never unlink the current producer's socket.
    if (!this.lock) return;
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    try { await fs.promises.unlink(this.socketPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await this.lock?.release();
    this.lock = null;
  }
}

async function requestRunningProducer(dataDir) {
  const socket = net.createConnection(controlSocketPath(dataDir));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Observer control connect timeout')); }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  socket.write(`${JSON.stringify({ action: 'pre-uninstall' })}\n`);
  const response = await readLine(socket, OPERATION_TIMEOUT_MS);
  socket.end();
  if (response?.ok !== true) throw Object.assign(new Error('Running Observer coordinator rejected teardown'), {
    code: response?.error || 'control_failed',
  });
  return { mode: 'online' };
}

export async function runObserverPreUninstall({ dataDir, configPath }) {
  try {
    return await requestRunningProducer(await fs.promises.realpath(dataDir));
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error;
  }
  const paths = observerPaths(dataDir);
  const lock = await acquireCoordinatorLock(paths.control, { timeoutMs: OPERATION_TIMEOUT_MS });
  try {
    const installer = new ObserverInstaller({ dataDir });
    const containment = createObserverContainment({ dataDir });
    const coordinator = new ObserverCoordinator({
      configPath,
      installer,
      teardown: ({ reason }) => containment.stopGeneration({ reason }),
      reconcilePersisted: () => containment.reconcilePersisted(),
    });
    await coordinator.uninstall();
    return { mode: 'offline' };
  } finally {
    await lock.release();
  }
}
