import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_ERROR_LENGTH = 500;

/**
 * Daily memory commit: runs zylos-memory's daily-commit.js and keeps the task's
 * state file. A failed run is recorded for the day as well (last_status
 * 'failed' with last_error), so it is not retried on every tick for the rest
 * of the hour; the next attempt is the next day.
 */
export function createDailyMemoryCommit({ stateFile, script, log, timeoutMs = 30000 }) {
  let lastError = null;

  function loadState() {
    try {
      if (!fs.existsSync(stateFile)) return null;
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch { }
    return null;
  }

  function writeState(date, ok = true) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        last_date: date,
        last_status: ok ? 'ok' : 'failed',
        ...(ok ? {} : { last_error: lastError }),
        updated_at: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      log(`Daily memory commit: failed to write state (${err.message})`);
    }
  }

  function execute() {
    lastError = null;
    try {
      const output = execFileSync('node', [script], {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (output.trim()) {
        log(`Daily memory commit: ${output.trim()}`);
      }
      return true;
    } catch (err) {
      const detail = err?.stderr?.toString?.().trim() || err.message;
      lastError = detail.length > MAX_ERROR_LENGTH ? `${detail.slice(0, MAX_ERROR_LENGTH)}…` : detail;
      log(`Daily memory commit failed: ${detail}`);
      return false;
    }
  }

  return { loadState, writeState, execute };
}
