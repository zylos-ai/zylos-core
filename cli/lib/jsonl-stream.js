import fs from 'node:fs';
import path from 'node:path';

export const JSONL_MAX_BYTES = 10 * 1024 * 1024;
export const JSONL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createJsonlStream(filename, { now = Date.now,
  maxBytes = JSONL_MAX_BYTES, retentionMs = JSONL_RETENTION_MS,
  write = (fd, buffer) => fs.writeSync(fd, buffer),
} = {}) {
  async function append(value) {
    const json = JSON.stringify(value);
    if (!json || !value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected JSON object');
    const buffer = Buffer.from(`${json}\n`);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(filename, 'a', 0o600);
    try {
      // One O_APPEND write, including the newline. Never retry a short write or
      // truncate: another process may already have appended after this fragment.
      if (write(fd, buffer) !== buffer.length) throw new Error('JSONL short write');
    } finally {
      fs.closeSync(fd);
    }
  }
  async function maintain() {
    const directory = path.dirname(filename);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let rotated = null;
    let stat;
    try { stat = fs.statSync(filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.size > maxBytes) {
      let stamp = now();
      let candidate;
      // Do not replace a previous rotation from this same millisecond.
      do { candidate = filename.replace(/\.jsonl$/, '') + `.${stamp++}.jsonl`; }
      while (fs.existsSync(candidate));
      try { fs.renameSync(filename, candidate); rotated = candidate; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const prefix = path.basename(filename).replace(/\.jsonl$/, '') + '.';
    let removed = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const suffix = entry.name.slice(prefix.length);
      if (!/^\d+\.jsonl$/.test(suffix)) continue;
      const stamp = Number(suffix.slice(0, -6));
      if (now() - stamp <= retentionMs) continue;
      try { fs.unlinkSync(path.join(directory, entry.name)); removed++; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { rotated, removed };
  }
  // append/maintain finish their I/O before returning; there is no wait queue.
  return { append, maintain };
}
