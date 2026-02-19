'use strict';
/**
 * Fetch Preload — Monkey-patches globalThis.fetch to track API call activity.
 *
 * Loaded before Claude Code via NODE_OPTIONS="--require <this-file>".
 * Writes activity snapshots to ~/zylos/activity-monitor/api-activity.json
 * so the activity monitor can detect stuck API calls in real time.
 *
 * Safety: all writes are best-effort. Failures are silently ignored
 * to never interfere with the host process.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const API_ACTIVITY_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'api-activity.json');

let activeFetches = 0;
let lastFetchStartMs = 0;
let lastFetchEndMs = 0;
let totalFetches = 0;

function writeActivity() {
  try {
    fs.writeFileSync(API_ACTIVITY_FILE, JSON.stringify({
      pid: process.pid,
      active_fetches: activeFetches,
      last_fetch_start: lastFetchStartMs,
      last_fetch_end: lastFetchEndMs,
      total_fetches: totalFetches,
      updated_at: Date.now()
    }));
  } catch {
    // Best-effort — never crash the host process.
  }
}

if (typeof globalThis.fetch === 'function') {
  const _originalFetch = globalThis.fetch;

  globalThis.fetch = function patchedFetch(...args) {
    activeFetches++;
    lastFetchStartMs = Date.now();
    totalFetches++;
    writeActivity();

    const onSettle = () => {
      activeFetches = Math.max(0, activeFetches - 1);
      lastFetchEndMs = Date.now();
      writeActivity();
    };

    return _originalFetch.apply(this, args).then(
      (res) => { onSettle(); return res; },
      (err) => { onSettle(); throw err; }
    );
  };
}
