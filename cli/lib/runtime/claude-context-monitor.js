/**
 * ClaudeContextMonitor — ContextMonitor implementation for Claude Code.
 *
 * Reads token usage from ~/zylos/activity-monitor/statusline.json, which is
 * written after every turn by the context-monitor.js statusLine hook.
 *
 * Fields used:
 *   context_window.used_percentage    — percent of context used (0–100)
 *   context_window.context_window_size — ceiling in tokens (e.g. 200000)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextMonitorBase } from './context-monitor-base.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const STATUSLINE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'statusline.json');

export class ClaudeContextMonitor extends ContextMonitorBase {
  /**
   * @param {object} [opts] - Passed to ContextMonitorBase
   */
  constructor(opts = {}) {
    super(opts);
  }

  /**
   * Read context usage from Claude Code's statusLine JSON file.
   *
   * @returns {Promise<{used: number, ceiling: number} | null>}
   */
  async getUsage() {
    try {
      const raw = fs.readFileSync(STATUSLINE_FILE, 'utf8');
      const status = JSON.parse(raw);
      const cw = status.context_window;
      if (!cw) return null;

      const pct = cw.used_percentage;
      const ceiling = cw.context_window_size;
      if (pct == null || !ceiling) return null;

      const used = Math.round((pct / 100) * ceiling);
      return { used, ceiling };
    } catch {
      return null;
    }
  }
}
