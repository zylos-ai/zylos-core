import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonl',
  '.log',
  '.yaml',
  '.yml'
]);

function memoryError(code, status = 400, details = {}) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  err.memoryBrowserError = true;
  Object.assign(err, details);
  return err;
}

function isoMtime(stat) {
  return stat.mtime instanceof Date ? stat.mtime.toISOString() : new Date(stat.mtimeMs).toISOString();
}

function isDrivePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z]:$/.test(value);
}

function isTextFileName(name) {
  return TEXT_EXTENSIONS.has(path.posix.extname(String(name || '').toLowerCase()));
}

function isValidUtf8Text(buffer) {
  const text = buffer.toString('utf8');
  // Reject replacement characters so mojibake cannot be saved back as if it
  // were a clean UTF-8 memory file.
  if (text.includes('\uFFFD')) return false;
  if (text.includes('\u0000')) return false;
  return true;
}

function assertWritableText(value, maxFileBytes) {
  if (typeof value !== 'string') throw memoryError('invalid_memory_write');
  // Keep write-side validation symmetric with reads: U+FFFD usually means a
  // previous decode already lost information, so do not persist it.
  if (value.includes('\u0000') || value.includes('\uFFFD')) {
    throw memoryError('invalid_memory_write');
  }
  if (Buffer.byteLength(value, 'utf8') > maxFileBytes) {
    throw memoryError('memory_file_too_large', 413);
  }
}

function assertExpectedSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw memoryError('invalid_memory_write');
  }
}

function filePayload(rel, stat, buffer) {
  return {
    path: rel,
    name: path.posix.basename(rel),
    size_bytes: stat.size,
    mtime: isoMtime(stat),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    markdown: ['.md', '.markdown'].includes(path.posix.extname(rel).toLowerCase())
  };
}

async function assertNoSymlinkPath(root, rel) {
  if (!rel) return;
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if (err.code === 'ENOENT') throw memoryError('memory_file_not_found', 404);
      throw err;
    }
    if (stat.isSymbolicLink()) throw memoryError('invalid_memory_path');
  }
}

function normalizeRelativeMemoryPath(input, { allowEmpty = false } = {}) {
  if (typeof input !== 'string') throw memoryError('invalid_memory_path');
  if (input.includes('\u0000')) throw memoryError('invalid_memory_path');
  if (input.includes('\\')) throw memoryError('invalid_memory_path');
  const value = input.trim();
  if (!value) {
    if (allowEmpty) return '';
    throw memoryError('invalid_memory_path');
  }
  if (value.startsWith('/') || isDrivePath(value)) throw memoryError('invalid_memory_path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw memoryError('invalid_memory_path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw memoryError('invalid_memory_path');
  }
  return normalized;
}

export function validateMemoryQueryPath(value, options = {}) {
  return normalizeRelativeMemoryPath(value, options);
}

export class MemoryBrowser {
  constructor({ zylosDir, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    this.memoryRoot = path.join(zylosDir || process.env.ZYLOS_DIR || process.cwd(), 'memory');
    this.maxFileBytes = maxFileBytes;
    this._realRoot = null;
    this._writeQueues = new Map();
  }

  async realRoot() {
    if (!this._realRoot) {
      this._realRoot = await fs.realpath(this.memoryRoot);
    }
    return this._realRoot;
  }

  async resolvePath(relativePath, { allowRoot = false, requireFile = false } = {}) {
    const rel = normalizeRelativeMemoryPath(relativePath || '', { allowEmpty: allowRoot });
    const root = await this.realRoot();
    const candidate = rel ? path.resolve(root, rel) : root;
    await assertNoSymlinkPath(root, rel);
    let real;
    try {
      real = await fs.realpath(candidate);
    } catch (err) {
      if (err.code === 'ENOENT') throw memoryError('memory_file_not_found', 404);
      throw err;
    }
    const inside = real === root || path.relative(root, real).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(root, real));
    if (!inside) throw memoryError('invalid_memory_path');
    const stat = await fs.lstat(real);
    if (stat.isSymbolicLink()) throw memoryError('invalid_memory_path');
    if (requireFile && !stat.isFile()) throw memoryError('invalid_memory_path');
    return { rel, real, stat };
  }

  async tree() {
    const root = await this.realRoot();
    const rootStat = await fs.lstat(root);
    return {
      root: {
        name: 'memory',
        path: '',
        type: 'directory',
        mtime: isoMtime(rootStat),
        children: await this.walkDirectory(root, '')
      }
    };
  }

  async walkDirectory(dir, relDir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nodes = [];
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = await fs.lstat(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        nodes.push({
          path: rel,
          name: entry.name,
          type: 'directory',
          mtime: isoMtime(stat),
          children: await this.walkDirectory(full, rel)
        });
      } else if (stat.isFile()) {
        nodes.push({
          path: rel,
          name: entry.name,
          type: 'file',
          size_bytes: stat.size,
          mtime: isoMtime(stat),
          renderable: isTextFileName(entry.name) && stat.size <= this.maxFileBytes
        });
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return nodes;
  }

  async file(relativePath) {
    const { rel, real, stat } = await this.resolvePath(relativePath, { requireFile: true });
    if (!isTextFileName(rel)) throw memoryError('unsupported_memory_file', 415);
    if (stat.size > this.maxFileBytes) throw memoryError('memory_file_too_large', 413);
    const buffer = await fs.readFile(real);
    if (!isValidUtf8Text(buffer)) throw memoryError('unsupported_memory_file', 415);
    const text = buffer.toString('utf8');
    return {
      ...filePayload(rel, stat, buffer),
      text
    };
  }

  async writeFile(relativePath, { text, sha256 } = {}) {
    assertWritableText(text, this.maxFileBytes);
    assertExpectedSha(sha256);
    const { rel, real, stat } = await this.resolvePath(relativePath, { requireFile: true });
    if (!isTextFileName(rel)) throw memoryError('unsupported_memory_file', 415);
    if (stat.size > this.maxFileBytes) throw memoryError('memory_file_too_large', 413);
    return this.withWriteLock(real, () => this.writeResolvedFile({ rel, real, text, sha256 }));
  }

  async withWriteLock(real, operation) {
    const previous = this._writeQueues.get(real) || Promise.resolve();
    let release;
    const current = new Promise(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this._writeQueues.set(real, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this._writeQueues.get(real) === tail) {
        this._writeQueues.delete(real);
      }
    }
  }

  async writeResolvedFile({ rel, real, text, sha256 }) {
    const currentStat = await fs.lstat(real);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
      throw memoryError('invalid_memory_path');
    }
    if (currentStat.size > this.maxFileBytes) throw memoryError('memory_file_too_large', 413);
    const currentBuffer = await fs.readFile(real);
    if (!isValidUtf8Text(currentBuffer)) throw memoryError('unsupported_memory_file', 415);
    const current = filePayload(rel, currentStat, currentBuffer);
    if (current.sha256 !== sha256) {
      throw memoryError('memory_conflict', 409, { current });
    }

    const nextBuffer = Buffer.from(text, 'utf8');
    const dir = path.dirname(real);
    const base = path.basename(real);
    const temp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temp, nextBuffer, { mode: currentStat.mode & 0o777 });
      await fs.rename(temp, real);
    } catch (err) {
      try {
        await fs.unlink(temp);
      } catch {
        // Best-effort cleanup for interrupted writes.
      }
      throw err;
    }

    const nextStat = await fs.lstat(real);
    return {
      ...filePayload(rel, nextStat, nextBuffer),
      text
    };
  }

  async git(relativePath) {
    const { rel } = await this.resolvePath(relativePath, { allowRoot: true });
    const root = await this.realRoot();
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        root,
        'log',
        '-1',
        '--format=%H%x00%h%x00%s%x00%an%x00%aI',
        '--',
        rel || '.'
      ], { timeout: 5000, maxBuffer: 1024 * 1024 });
      const line = stdout.trim();
      if (!line) return { path: rel, commit: null };
      const [hash, shortHash, subject, authorName, authorDate] = line.split('\u0000');
      if (!hash) return { path: rel, commit: null };
      return {
        path: rel,
        commit: {
          hash,
          short_hash: shortHash,
          subject,
          author_name: authorName,
          author_date: authorDate
        }
      };
    } catch {
      return { path: rel, commit: null };
    }
  }
}

export function memoryErrorPayload(err) {
  if (!err?.memoryBrowserError) {
    return {
      status: 500,
      body: { error: 'memory_browser_failed' }
    };
  }
  return {
    status: err.status,
    body: {
      error: err.code,
      ...(err.current ? { current: err.current } : {})
    }
  };
}
