import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

export const DEFAULT_FINALIZE_TIMEOUT_MS = 600000;
export const LEGACY_FINALIZE_TIMEOUT_MS = 180000;
export const MIN_FINALIZE_TIMEOUT_MS = 60000;
export const MAX_FINALIZE_TIMEOUT_MS = 3600000;

export function parseFinalizeTimeout(value = DEFAULT_FINALIZE_TIMEOUT_MS / 1000) {
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < MIN_FINALIZE_TIMEOUT_MS / 1000 || Number(value) > MAX_FINALIZE_TIMEOUT_MS / 1000) {
    throw Object.assign(Error('finalize timeout must be an integer from 60 to 3600 seconds'), {code:'INVALID_ARGS'});
  }
  return Number(value) * 1000;
}

function budget(deadlineAt, now) {
  const monotonicDeadline = performance.now() + deadlineAt - now;
  return {
    deadlineAt,
    remaining: () => Math.max(0, monotonicDeadline - performance.now()),
    check() {
      if (performance.now() >= monotonicDeadline) throw Object.assign(Error('finalize budget exhausted'), {code:'deadline_exceeded'});
    }
  };
}

export function readFinalizeState(statePath, {now = Date.now()} = {}) {
  const fd = fs.openSync(statePath, 'r');
  let state, stat;
  try { state = JSON.parse(fs.readFileSync(fd, 'utf8')); stat = fs.fstatSync(fd); }
  finally { fs.closeSync(fd); }
  const timeout = Object.hasOwn(state,'finalizeTimeoutMs') ? state.finalizeTimeoutMs : LEGACY_FINALIZE_TIMEOUT_MS;
  const floor = Math.floor(stat.mtimeMs / 1000) * 1000;
  if (!Number.isInteger(timeout) || timeout < MIN_FINALIZE_TIMEOUT_MS || timeout > MAX_FINALIZE_TIMEOUT_MS || !Number.isFinite(floor) || floor > now) {
    throw Object.assign(Error('cannot determine parent finalize budget'), {code:'FINALIZE_BUDGET_INVALID'});
  }
  return {state, budget:budget(floor + timeout - 1000, now)};
}

export function resumeFinalizeBudget(timeoutSeconds, entryAt = Date.now()) {
  return budget(entryAt + parseFinalizeTimeout(timeoutSeconds) - 1000, Date.now());
}
