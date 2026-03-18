/**
 * ProcSampler — cross-platform frozen-process detection via context-switch sampling.
 *
 * Linux:  reads /proc/<pid>/status → voluntary + nonvoluntary context switches
 * macOS:  runs `top -l 1 -pid <pid> -stats pid,csw` → CSW column
 *
 * Both yield a monotonically increasing integer. If the delta between consecutive
 * samples is 0 for FROZEN_THRESHOLD seconds, the process is declared frozen.
 *
 * Usage:
 *   const sampler = new ProcSampler({ sessionName: 'claude-main', log });
 *   // called every second from monitorLoop:
 *   sampler.tick(currentTimeSeconds);
 *   sampler.isFrozen()  // → true/false
 *   sampler.isAlive()   // → true/false/null (null = insufficient data)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const SAMPLE_INTERVAL = 10;   // seconds between samples
const FROZEN_THRESHOLD = 60;  // seconds of zero delta → frozen

const PROC_STATE_FILE = path.join(
  process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  'activity-monitor',
  'proc-state.json'
);

export class ProcSampler {
  /**
   * @param {object} opts
   * @param {string} opts.sessionName  tmux session name (e.g. 'claude-main')
   * @param {function} opts.log        logging function
   * @param {number}  [opts.sampleInterval]  seconds between samples (default 10)
   * @param {number}  [opts.frozenThreshold] seconds of zero-delta to declare frozen (default 60)
   */
  constructor({ sessionName, log, sampleInterval, frozenThreshold } = {}) {
    this._sessionName = sessionName;
    this._log = log || (() => {});
    this._sampleInterval = sampleInterval || SAMPLE_INTERVAL;
    this._frozenThreshold = frozenThreshold || FROZEN_THRESHOLD;

    this._lastPid = null;
    this._lastCtxTotal = null;
    this._lastSampleAt = 0;
    this._frozenCount = 0;        // consecutive seconds of zero delta
    this._alive = null;           // true/false/null
    this._lastDelta = null;
    this._platform = process.platform;
  }

  /** Update session name (e.g. on runtime switch). Resets state. */
  setSessionName(name) {
    if (name !== this._sessionName) {
      this._sessionName = name;
      this.reset();
    }
  }

  /** Reset all sampling state. */
  reset() {
    this._lastPid = null;
    this._lastCtxTotal = null;
    this._lastSampleAt = 0;
    this._frozenCount = 0;
    this._alive = null;
    this._lastDelta = null;
    this._writeProcState();
  }

  /**
   * Called every second from monitorLoop. Internally gates on sampleInterval.
   * @param {number} currentTime  epoch seconds
   * @param {object} [opts]
   * @param {boolean} [opts.isActive]  true when agent has active tools (expected to be working)
   */
  tick(currentTime, opts = {}) {
    if ((currentTime - this._lastSampleAt) < this._sampleInterval) return;
    this._lastSampleAt = currentTime;

    const pid = this._findRuntimePid();
    if (pid === null) {
      // Can't find process — skip this sample, don't change frozen count.
      // Guardian handles offline/stopped separately.
      this._alive = null;
      this._writeProcState();
      return;
    }

    // PID changed → new process, reset counters
    if (pid !== this._lastPid) {
      if (this._lastPid !== null) {
        this._log(`ProcSampler: PID changed ${this._lastPid} → ${pid}, resetting`);
      }
      this._lastPid = pid;
      this._lastCtxTotal = null;
      this._frozenCount = 0;
    }

    const ctxTotal = this._sampleCtxSwitches(pid);
    if (ctxTotal === null) {
      // Sampling failed (process may have exited between findPid and sample)
      this._alive = null;
      this._writeProcState();
      return;
    }

    if (this._lastCtxTotal === null) {
      // First sample for this PID — store baseline, can't compute delta yet
      this._lastCtxTotal = ctxTotal;
      this._alive = null;
      this._writeProcState();
      return;
    }

    const delta = ctxTotal - this._lastCtxTotal;
    this._lastCtxTotal = ctxTotal;
    this._lastDelta = delta;

    if (delta > 0) {
      this._frozenCount = 0;
      this._alive = true;
    } else if (opts.isActive) {
      // Only accumulate frozen count when agent is expected to be working
      // (active_tools > 0). An idle agent waiting for input naturally has
      // zero context switches — that's normal, not frozen.
      this._frozenCount += this._sampleInterval;
      this._alive = this._frozenCount < this._frozenThreshold;
    } else {
      // Idle — zero delta is expected, don't accumulate frozen count
      this._frozenCount = 0;
      this._alive = true;
    }

    this._writeProcState();
  }

  /** @returns {boolean} true if frozen for >= threshold seconds */
  isFrozen() {
    return this._frozenCount >= this._frozenThreshold;
  }

  /** @returns {boolean|null} true=alive, false=frozen, null=insufficient data */
  isAlive() {
    return this._alive;
  }

  /** @returns {object} current state snapshot */
  getState() {
    return {
      pid: this._lastPid,
      alive: this._alive,
      frozen: this.isFrozen(),
      frozenCount: this._frozenCount,
      lastDelta: this._lastDelta,
      lastSampleAt: this._lastSampleAt,
      platform: this._platform,
    };
  }

  // ---- Private ----

  /**
   * Discover the runtime process PID via tmux pane → child process.
   * @returns {number|null}
   */
  _findRuntimePid() {
    try {
      const panePid = execSync(
        `tmux list-panes -t "${this._sessionName}" -F '#{pane_pid}' 2>/dev/null`,
        { encoding: 'utf8', stdio: 'pipe', timeout: 3000 }
      ).trim();
      if (!panePid) return null;

      const childPid = execSync(
        `pgrep -P ${panePid}`,
        { encoding: 'utf8', stdio: 'pipe', timeout: 1000 }
      ).trim();
      if (!childPid) return null;

      // pgrep may return multiple children; take the first
      const pid = parseInt(childPid.split('\n')[0], 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * Read context-switch count for a given PID. Cross-platform.
   * @param {number} pid
   * @returns {number|null}
   */
  _sampleCtxSwitches(pid) {
    if (this._platform === 'linux') {
      return this._sampleLinux(pid);
    }
    if (this._platform === 'darwin') {
      return this._sampleDarwin(pid);
    }
    // Unsupported platform — sampling disabled
    return null;
  }

  /** Linux: read /proc/<pid>/status for context switches */
  _sampleLinux(pid) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const volMatch = status.match(/voluntary_ctxt_switches:\s+(\d+)/);
      const nvolMatch = status.match(/nonvoluntary_ctxt_switches:\s+(\d+)/);
      const vol = volMatch ? parseInt(volMatch[1], 10) : 0;
      const nvol = nvolMatch ? parseInt(nvolMatch[1], 10) : 0;
      return vol + nvol;
    } catch {
      return null;
    }
  }

  /** macOS: use top to get CSW for a single process */
  _sampleDarwin(pid) {
    try {
      const out = execSync(
        `top -l 1 -pid ${pid} -stats pid,csw -s 0 2>/dev/null`,
        { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }
      );
      // Parse the last line that looks like: "  <pid>  <csw>"
      const lines = out.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^\s*\d+\s+(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Write current state to proc-state.json for other processes (dispatcher) to read.
   * Uses atomic write (write tmp → rename) to avoid partial reads.
   */
  _writeProcState() {
    try {
      const state = {
        pid: this._lastPid,
        alive: this._alive,
        frozen: this.isFrozen(),
        frozenCount: this._frozenCount,
        lastDelta: this._lastDelta,
        lastSampleAt: this._lastSampleAt,
        platform: this._platform,
      };
      const tmpPath = PROC_STATE_FILE + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      fs.renameSync(tmpPath, PROC_STATE_FILE);
    } catch {
      // Best-effort — don't crash the monitor loop
    }
  }
}

/**
 * Read proc-state.json written by the activity monitor.
 * Intended for use by the dispatcher (or any external process).
 * @returns {object|null}
 */
export function readProcState() {
  try {
    if (!fs.existsSync(PROC_STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PROC_STATE_FILE, 'utf8'));
    // Treat stale data (>30s old) as unknown
    const age = Math.floor(Date.now() / 1000) - (data.lastSampleAt || 0);
    if (age > 30) return null;
    return data;
  } catch {
    return null;
  }
}
