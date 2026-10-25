import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configLockArgs } from './config-lock.js';

export const JSONL_MAX_BYTES = 10 * 1024 * 1024;
export const JSONL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// The child holds the actual stream inode lock until the parent's operation
// finishes. Waiting is asynchronous; there is deliberately no unlocked fallback.
export async function lockJsonlFile(file, { waitMs = 10000, platform = process.platform } = {}) {
  const capability = platform === 'linux' ? { backend: 'linux-flock', executable: 'flock' }
    : platform === 'darwin' ? { backend: 'macos-perl', executable: '/usr/bin/perl' } : null;
  if (!capability) throw new Error('JSONL file locking is unavailable');
  const child = spawn(capability.executable,
    configLockArgs(capability, waitMs, ['/bin/sh', '-c', 'printf "locked\\n"; cat >/dev/null']),
    { stdio: ['pipe', 'pipe', 'pipe', file.fd] });
  let ready = false, output = '', stderr = '', failure;
  child.stdin.on('error', error => { failure ??= error; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2048); });
  const finished = new Promise(resolve => {
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      if (code !== 0) failure ??= new Error(`JSONL lock helper exited ${code}: ${stderr.trim()}`);
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      output += data;
      if (output === 'locked\n' && !ready) { ready = true; resolve(); }
    });
    finished.then(() => { if (!ready) reject(failure || new Error('JSONL lock helper did not acquire lock')); });
  });
  return async () => {
    child.stdin.end();
    await finished;
    if (failure) throw failure;
  };
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function createJsonlStream(filename, { lock = lockJsonlFile, now = Date.now,
  maxBytes = JSONL_MAX_BYTES, retentionMs = JSONL_RETENTION_MS,
  write = (file, buffer, offset) => file.write(buffer, offset, buffer.length - offset, null),
} = {}) {
  let queue = Promise.resolve();
  const enqueue = operation => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  async function withCurrentFile(operation) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    for (;;) {
      const file = await fs.open(filename, 'a+', 0o600);
      let unlock;
      try {
        unlock = await lock(file);
        const opened = await file.stat();
        let current;
        try { current = await fs.stat(filename); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!current || !sameFile(opened, current)) continue;
        return await operation(file, opened);
      } finally {
        try { if (unlock) await unlock(); }
        finally { await file.close(); }
      }
    }
  }
  function append(value) {
    // Serialize before queueing so later caller mutation cannot alter the line.
    const json = JSON.stringify(value);
    if (!json || !value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected JSON object');
    const buffer = Buffer.from(`${json}\n`);
    return enqueue(() => withCurrentFile(async (file, before) => {
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await write(file, buffer, offset);
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) throw new Error('Invalid JSONL short write');
          offset += bytesWritten;
        }
      } catch (error) {
        await file.truncate(before.size);
        throw error;
      }
    }));
  }
  function maintain() {
    return enqueue(async () => {
      let rotated = null;
      await withCurrentFile(async (_file, stat) => {
        if (stat.size <= maxBytes) return;
        let stamp = now();
        // Timestamp-only names are part of the stream format. Never overwrite
        // an earlier rotation when maintenance runs twice in one millisecond.
        for (;;) {
          const candidate = filename.replace(/\.jsonl$/, '') + `.${stamp}.jsonl`;
          try { await fs.stat(candidate); stamp++; }
          catch (error) { if (error.code !== 'ENOENT') throw error; rotated = candidate; break; }
        }
        await fs.rename(filename, rotated);
      });
      const directory = path.dirname(filename);
      const prefix = path.basename(filename).replace(/\.jsonl$/, '') + '.';
      let removed = 0;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const suffix = entry.name.slice(prefix.length);
        if (!/^\d+\.jsonl$/.test(suffix)) continue;
        const stamp = Number(suffix.slice(0, -6));
        if (now() - stamp <= retentionMs) continue;
        try { await fs.unlink(path.join(directory, entry.name)); removed++; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return { rotated, removed };
    });
  }
  return { append, maintain, flush: () => queue };
}
