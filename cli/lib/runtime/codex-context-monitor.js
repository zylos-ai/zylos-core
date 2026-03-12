/**
 * CodexContextMonitor — ContextMonitor implementation for OpenAI Codex CLI.
 *
 * Data sources (in priority order):
 *   1. Active JSONL rollout file — scan tail for last `event_msg:token_count` event.
 *      Fields: info.total_token_usage.input_tokens (used) + info.model_context_window (ceiling).
 *      Note: model_context_window in the event is already the effective ceiling
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
    this._cachedCeiling = null;
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
      fs.readSync(fd, buf, 0, readBytes, offset);
      fs.closeSync(fd);

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
            event.payload?.info?.total_token_usage?.input_tokens != null
          ) {
            const used = event.payload.info.total_token_usage.input_tokens;
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
   * @returns {string | null}
   */
  _getActiveRolloutPath() {
    try {
      const sql = `SELECT rollout_path FROM threads
                   WHERE archived = 0
                   ORDER BY updated_at DESC
                   LIMIT 1;`;
      const out = execFileSync('sqlite3', [SQLITE_FILE, sql], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
      }).trim();
      return out || null;
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
      const sql = `SELECT tokens_used FROM threads
                   WHERE archived = 0
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
   * Result is cached after first successful read.
   *
   * @returns {number}
   */
  _getModelCeiling() {
    if (this._cachedCeiling) return this._cachedCeiling;

    try {
      const cache = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'));
      const models = cache.models ?? [];
      const model = this._model
        ? (models.find(m => m.slug === this._model) ?? models[0])
        : models[0];

      if (model?.context_window) {
        const pct = model.effective_context_window_percent ?? 100;
        this._cachedCeiling = Math.round(model.context_window * (pct / 100));
        return this._cachedCeiling;
      }
    } catch { /* models_cache.json missing or malformed */ }

    return DEFAULT_CEILING;
  }
}
