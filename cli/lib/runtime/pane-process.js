import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SUPPORTED_RUNTIMES } from './descriptors.js';

export const PANE_PROCESS_FILE = 'pane-process.json';
export const processName = comm => typeof comm === 'string' ? path.basename(comm).replace(/\.exe$/, '') : null;

const positive = value => Number.isSafeInteger(value) && value > 0;
const startValue = value => typeof value === 'string' && value.length > 0 && value.length <= 64;

export function writePaneProcess(dir, { runId, runtime, panePid, paneStart }) {
  if (typeof runId !== 'string' || !runId || !SUPPORTED_RUNTIMES.includes(runtime) || !positive(panePid) || !startValue(paneStart)) {
    throw new TypeError('Invalid pane process record');
  }
  const record = { v: 1, runId, runtime, panePid, paneStart };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, PANE_PROCESS_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  return record;
}

export function readPaneProcess(dir, { fsImpl = fs } = {}) {
  let value;
  try { value = JSON.parse(fsImpl.readFileSync(path.join(dir, PANE_PROCESS_FILE), 'utf8')); }
  catch { return null; }
  if (!value || value.v !== 1 || typeof value.runId !== 'string' || !value.runId || !SUPPORTED_RUNTIMES.includes(value.runtime) ||
    !positive(value.panePid) || !startValue(value.paneStart)) return null;
  return value;
}

/**
 * Whether a process identity `{pid, start, ppid, parentStart}` is the pane
 * process: the pane process itself, or the direct child of a launcher wrapper pane.
 */
export function belongsToPane(identity, { runtime, panePid, paneStart = null, paneComm = null, wrapsNative = false }) {
  if (!identity || !positive(panePid)) return false;
  // A start time missing on either side compares pids only.
  const sameStart = start => start == null || paneStart == null || start === paneStart;
  if (identity.pid === panePid) return sameStart(identity.start);
  if (identity.ppid === panePid && wrapsNative && typeof paneComm === 'string' &&
      paneComm.length > 0 && processName(paneComm) !== runtime) return sameStart(identity.parentStart);
  return false;
}
