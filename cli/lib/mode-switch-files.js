/** W4 fixed first line and W6 atomic file replacement; no business orchestration. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertModeSwitchRunId } from './session-memory-paths.js';

function validate(record) {
  assertModeSwitchRunId(record.runId);
  if (!Number.isSafeInteger(record.cutoff) || record.cutoff < 0 ||
      !['single', 'multi'].includes(record.source) || !['single', 'multi'].includes(record.target) ||
      record.source === record.target) {
    const error = new Error('Invalid mode-switch header fields');
    error.code = 'MODE_SWITCH_HEADER_INVALID';
    throw error;
  }
}
export function formatModeSwitchHeader(record) {
  validate(record);
  return `<!-- zylos-mode-switch v1 | run=${record.runId} | cutoff=${record.cutoff} | source=${record.source} | target=${record.target} -->`;
}
export function parseModeSwitchHeader(content) {
  if (typeof content !== 'string') return null;
  const first = content.split('\n', 1)[0];
  const match = /^<!-- zylos-mode-switch v1 \| run=([^ |]+) \| cutoff=(0|[1-9][0-9]*) \| source=(single|multi) \| target=(single|multi) -->$/.exec(first);
  if (!match) return null;
  const record = { runId: match[1], cutoff: Number(match[2]), source: match[3], target: match[4] };
  try { validate(record); } catch { return null; }
  return record;
}
export function formatModeSwitchHandoff(record, body = '') {
  if (typeof body !== 'string') throw new TypeError('Handoff body must be text');
  return `${formatModeSwitchHeader(record)}\n${body}`;
}

/**
 * Atomic full replacement. Parent creation is explicit caller responsibility.
 * A rename error is conservatively unknown; a durable-directory sync error is
 * after commit. We never report either as "nothing changed".
 */
export function writeModeSwitchFile(target, content, { fsImpl = fs } = {}) {
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new TypeError('File content must be text or bytes');
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd;
  let phase = 'before_rename';
  try {
    fd = fsImpl.openSync(temp, 'wx', 0o600);
    fsImpl.writeFileSync(fd, content);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd); fd = undefined;
    phase = 'rename';
    fsImpl.renameSync(temp, target);
    phase = 'after_rename';
    const dirFd = fsImpl.openSync(path.dirname(target), 'r');
    try { fsImpl.fsyncSync(dirFd); } finally { fsImpl.closeSync(dirFd); }
    return { committed: true };
  } catch (cause) {
    const error = new Error('Mode-switch file replacement failed', { cause });
    error.code = 'MODE_SWITCH_FILE_WRITE_FAILED';
    error.phase = phase;
    error.persisted = phase === 'before_rename' ? [] : null;
    throw error;
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch {} }
    // Remove only our uncommitted temporary file. Never remove the destination.
    try { fsImpl.unlinkSync(temp); } catch {}
  }
}
