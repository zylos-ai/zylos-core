import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from './sqlite-driver.js';
import { DATA_DIR } from './c4-config.js';

// PM2 writes this file before publishing the child as its managed process.
// During its missing-ps double callback, only the last child remains selected.
function selectedPid(env) {
  if (env.pm_id === undefined) return null;
  if (!env.pm_pid_path) return undefined;
  try {
    const value = Number(fs.readFileSync(env.pm_pid_path, 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}

const execute = promisify(execFile);
async function managedPid(env, signal) {
  try {
    const { stdout } = await execute('pm2', ['jlist'], {
      env, signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    });
    const rows = JSON.parse(stdout);
    const row = rows.find(row => String(row.pm_id) === String(env.pm_id));
    return Number.isSafeInteger(row?.pid) && row.pid > 0 ? row.pid : undefined;
  } catch { return undefined; }
}

/** Hold a separate SQLite file's exclusive transaction for the whole delivery
 * lifetime. No application rows/schema are stored here. Never unlink the file:
 * replacing its inode would allow two independent owners. OS process teardown
 * releases the lock even after SIGKILL; no PID/stale-lock deletion is needed. */
export async function acquireDispatcherOwnership({ directory = DATA_DIR, env = process.env,
  signal, onSuperseded, pollMs = 100, log = () => {},
  readManagedPid = managedPid,
} = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(directory, 'dispatcher-lock.db'), { timeout: 0 });
  let monitor;
  let released = false;
  const observation = new AbortController();
  const observationSignal = signal ? AbortSignal.any([signal, observation.signal]) : observation.signal;
  let lastRead = 0, cachedPid;
  const selection = async () => {
    const pid = selectedPid(env);
    if (pid !== undefined) return pid;
    // PM2's second stop callback can unlink the replacement's PID file and
    // then refuse to start another child ("process already online"). Query its
    // actual slot in that case; do not wait forever for a file it won't write.
    if (Date.now() - lastRead >= 1000) {
      lastRead = Date.now();
      cachedPid = await readManagedPid(env, observationSignal);
    }
    return cachedPid;
  };
  const release = () => {
    if (released) return;
    released = true;
    observation.abort();
    clearInterval(monitor);
    db.close();
  };
  try {
    for (;;) {
      if (signal?.aborted) { release(); return null; }
      const selected = await selection();
      if (selected !== null && selected !== undefined && selected !== process.pid) {
        log('Dispatcher superseded before admission');
        release(); return null;
      }
      // An unobservable PM2 selection cannot authorize recovery or delivery.
      if (selected !== undefined) {
        try {
          db.exec('BEGIN EXCLUSIVE');
          // Selection can change while the SQLite lock is acquired.
          if (await selection() === selected) break;
          db.exec('ROLLBACK');
        } catch (error) {
          if (error.code !== 'SQLITE_BUSY') throw error;
        }
      }
      await delay(pollMs, undefined, { signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
    if (env.pm_id !== undefined && env.pm_pid_path) {
      let checking = false;
      monitor = setInterval(async () => {
        if (checking || released) return;
        checking = true;
        let selected;
        try { selected = await selection(); }
        finally { checking = false; }
        if (released) return;
        if (selected === null || selected === undefined || selected === process.pid) return;
        clearInterval(monitor);
        log('Dispatcher superseded; draining before ownership release');
        onSuperseded();
      }, pollMs);
    }
    return { release };
  } catch (error) {
    release(); throw error;
  }
}
