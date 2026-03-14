/**
 * CodexContextMonitor — ContextMonitor implementation for OpenAI Codex CLI.
 *
 * Data sources (in priority order):
 *   1. Active JSONL rollout file — scan tail for last `event_msg:token_count` event.
 *      Fields: info.last_token_usage.input_tokens (current window fill) + info.model_context_window (ceiling).
 *      Note: last_token_usage.input_tokens = tokens sent in the last turn = current context fill.
 *      total_token_usage.input_tokens is cumulative session cost — do NOT use it for context monitoring.
 *      model_context_window in the event is already the effective ceiling
 *      (context_window × effective_context_window_percent / 100).
 *   2. SQLite state_5.sqlite fallback — threads.tokens_used + models_cache.json ceiling.
 *
 * Ceiling fallback chain:
 *   token_count event → ~/.codex/models_cache.json → DEFAULT_CEILING (128K)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ContextMonitorBase } from './context-monitor-base.js';

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const SQLITE_FILE = path.join(CODEX_DIR, 'state_5.sqlite');
const MODELS_CACHE_FILE = path.join(CODEX_DIR, 'models_cache.json');

// Bytes to read from the end of the JSONL file — large enough to capture
// several turns including their token_count events.
const TAIL_BYTES = 65_536; // 64 KB

// Fallback ceiling when models_cache.json is unavailable
const DEFAULT_CEILING = 128_000;

export class CodexContextMonitor extends ContextMonitorBase {
  /**
   * @param {object} [opts]
   * @param {string} [opts.model] - Model slug to look up in models_cache.json.
   *   When omitted, uses the first model in the cache (most recently used).
   */
  constructor(opts = {}) {
    super(opts);
    this._model = opts.model ?? null;
    // Record start time so SQLite queries ignore threads from prior sessions.
    // Threads updated before this timestamp belong to a previous Codex run.
    this._startTime = Math.floor(Date.now() / 1000);
  }

  /**
   * Read context usage from the active Codex session.
   *
   * @returns {Promise<{used: number, ceiling: number} | null>}
   */
  async getUsage() {
    // Primary: JSONL rollout tail (most accurate, includes live model_context_window)
    const jsonlResult = this._readFromJsonl();
    if (jsonlResult) return jsonlResult;

    // Fallback: SQLite tokens_used + models_cache.json ceiling
    return this._readFromSqlite();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Find the active JSONL rollout path via SQLite, then scan its tail for
   * the most recent token_count event.
   *
   * @returns {{used: number, ceiling: number} | null}
   */
  _readFromJsonl() {
    const rolloutPath = this._getActiveRolloutPath();
    if (!rolloutPath) return null;

    try {
      const stat = fs.statSync(rolloutPath);
      if (!stat.size) return null;

      // Read only the tail to avoid loading large session files
      const readBytes = Math.min(TAIL_BYTES, stat.size);
      const offset = stat.size - readBytes;
      const buf = Buffer.alloc(readBytes);
      const fd = fs.openSync(rolloutPath, 'r');
      try {
        fs.readSync(fd, buf, 0, readBytes, offset);
      } finally {
        fs.closeSync(fd);
      }

      const lines = buf.toString('utf8').split('\n');

      // Scan from end for the most recent token_count event
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (
            event.type === 'event_msg' &&
            event.payload?.type === 'token_count' &&
            event.payload?.info?.last_token_usage?.input_tokens != null
          ) {
            // last_token_usage.input_tokens = tokens sent in the last turn =
            // current context window fill. Do NOT use total_token_usage.input_tokens,
            // which is cumulative session cost and grows unboundedly across turns.
            const used = event.payload.info.last_token_usage.input_tokens;
            // model_context_window is the effective ceiling (already multiplied by pct)
            const ceiling = event.payload.info.model_context_window ?? this._getModelCeiling();
            return { used, ceiling };
          }
        } catch { /* skip malformed or partial line at read boundary */ }
      }
    } catch { /* file unreadable or stat failed */ }

    return null;
  }

  /**
   * Read the active rollout path from SQLite threads table.
   * Returns the most recently updated non-archived thread's rollout path.
   *
   * Falls back to filesystem scan when sqlite3 CLI is unavailable (e.g. Docker).
   *
   * @returns {string | null}
   */
  _getActiveRolloutPath() {
    // Primary: SQLite query (most accurate — respects archived flag)
    try {
      const sql = `SELECT rollout_path FROM threads
                   WHERE archived = 0
                     AND updated_at >= ${this._startTime}
                   ORDER BY updated_at DESC
                   LIMIT 1;`;
      const out = execFileSync('sqlite3', [SQLITE_FILE, sql], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
      }).trim();
      if (out) return out;
    } catch { /* sqlite3 CLI unavailable — fall through to filesystem scan */ }

    // Fallback: scan ~/.codex/sessions/ for the most recently modified JSONL
    // file that was updated after this monitor started. Used when sqlite3 is
    // not installed (e.g. minimal Docker images).
    return this._getActiveRolloutPathFromFilesystem();
  }

  /**
   * Filesystem fallback: walk ~/.codex/sessions/YYYY/MM/DD/ and return the
   * most recently modified rollout-*.jsonl file updated after _startTime.
   *
   * @returns {string | null}
   */
  _getActiveRolloutPathFromFilesystem() {
    try {
      const sessionsDir = path.join(CODEX_DIR, 'sessions');
      let best = null;
      let bestMtime = 0;

      // Walk up to 3 directory levels: YYYY/MM/DD
      for (const year of _readdirSafe(sessionsDir)) {
        for (const month of _readdirSafe(path.join(sessionsDir, year))) {
          for (const day of _readdirSafe(path.join(sessionsDir, year, month))) {
            const dayDir = path.join(sessionsDir, year, month, day);
            for (const file of _readdirSafe(dayDir)) {
              if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
              const fpath = path.join(dayDir, file);
              try {
                const { mtimeMs } = fs.statSync(fpath);
                const mtimeSec = mtimeMs / 1000;
                if (mtimeSec >= this._startTime && mtimeSec > bestMtime) {
                  bestMtime = mtimeSec;
                  best = fpath;
                }
              } catch { /* stat failed — skip */ }
            }
          }
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  /**
   * Fallback: read tokens_used from SQLite + ceiling from models_cache.json.
   *
   * @returns {{used: number, ceiling: number} | null}
   */
  _readFromSqlite() {
    try {
      // Same start-time filter as _getActiveRolloutPath() — ignore stale threads.
      const sql = `SELECT tokens_used FROM threads
                   WHERE archived = 0
                     AND updated_at >= ${this._startTime}
                   ORDER BY updated_at DESC
                   LIMIT 1;`;
      const out = execFileSync('sqlite3', [SQLITE_FILE, sql], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
      }).trim();
      if (!out) return null;
      const tokensUsed = parseInt(out, 10);
      if (isNaN(tokensUsed)) return null;
      return { used: tokensUsed, ceiling: this._getModelCeiling() };
    } catch {
      return null;
    }
  }

  /**
   * Get effective context window ceiling from ~/.codex/models_cache.json.
   * Effective ceiling = context_window × (effective_context_window_percent / 100).
   *
   * Not cached — re-reads on each call so a model upgrade mid-session is
   * reflected without requiring a PM2 restart. The file is small (~2 KB).
   *
   * @returns {number}
   */
  _getModelCeiling() {
    try {
      const cache = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'));
      const models = cache.models ?? [];
      const model = this._model
        ? (models.find(m => m.slug === this._model) ?? models[0])
        : models[0];

      if (model?.context_window) {
        const pct = model.effective_context_window_percent ?? 100;
        return Math.round(model.context_window * (pct / 100));
      }
    } catch { /* models_cache.json missing or malformed */ }

    return DEFAULT_CEILING;
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

/**
 * Safe readdir — returns empty array instead of throwing on missing/unreadable dirs.
 * @param {string} dir
 * @returns {string[]}
 */
function _readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
