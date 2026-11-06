import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function writeError(code, status, details = {}) {
  return Object.assign(new Error(code), { code, status, memoryBrowserError: true, ...details });
}

/** execFile has no input option: feed memory text through its stdin pipe. */
export function executeMemoryWrite(file, args, options, text) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    // An early process exit is classified by execFile's completion callback.
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
  });
}

/** Core owns the shared Sync lock, hash comparison and atomic publication. */
export function createMemoryWriter({ zylosDir, env = process.env, execute = executeMemoryWrite } = {}) {
  const script = path.join(zylosDir, '.claude', 'skills', 'zylos-memory', 'scripts', 'memory-write.js');
  return async function saveMemory(rel, { text, sha256 }) {
    try { await fs.access(script); }
    catch { throw writeError('memory_write_unavailable', 503); }
    const childEnv = { ...env, ZYLOS_DIR: zylosDir };
    delete childEnv.ZYLOS_SESSION_GROUP;
    let stdout;
    try {
      ({ stdout } = await execute(process.execPath, [script, '--path', rel, '--sha256', sha256], {
        env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024,
      }, text));
    } catch (error) {
      // Core reports rejected writes in stdout and exits nonzero. A killed or
      // timed out child has an unknown outcome even if it printed partial JSON.
      if (error.killed || error.signal || error.code === 'ETIMEDOUT' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw writeError('memory_write_unknown', 502);
      }
      stdout = error.stdout;
    }
    let envelope;
    try { envelope = JSON.parse(stdout); }
    catch { throw writeError('memory_write_unknown', 502); }
    if (envelope?.ok === true) return envelope.data;
    if (envelope?.ok !== false || typeof envelope.error?.code !== 'string') {
      throw writeError('memory_write_unknown', 502);
    }
    const code = envelope.error.code;
    const mapping = {
      MEMORY_CONFLICT: ['memory_conflict', 409],
      SYNC_BUSY: ['memory_sync_busy', 409],
      LOCK_TIMEOUT: ['memory_lock_timeout', 503],
      INVALID_MEMORY_PATH: ['invalid_memory_path', 400],
      MEMORY_FILE_NOT_FOUND: ['memory_file_not_found', 404],
      INVALID_INPUT: ['invalid_memory_write', 400],
    };
    const [message, status] = Object.hasOwn(mapping, code) ? mapping[code] : ['memory_write_failed', 500];
    throw writeError(message, status, {
      ...(message === 'memory_write_failed' ? { coreCode: code } : {}),
      ...(code === 'MEMORY_CONFLICT' ? { current: envelope.error.current } : {}),
    });
  };
}
