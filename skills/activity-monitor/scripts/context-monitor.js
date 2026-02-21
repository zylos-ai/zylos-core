#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const STATUS_FILE = '/tmp/claude-status.json';
const STATE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'context-monitor-state.json');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');

const RESTART_THRESHOLD = 70;
const COOLDOWN_SECONDS = 600;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try { main(input); } catch (err) {
    try {
      fs.appendFileSync(path.join(ZYLOS_DIR, 'activity-monitor', 'context-monitor.log'),
        `${new Date().toISOString()} ERROR: ${err.message}\n`);
    } catch {}
  }
});

function main(raw) {
  const status = JSON.parse(raw);
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  const usedPct = status.context_window?.used_percentage;
  if (usedPct == null || usedPct < RESTART_THRESHOLD) return;
  const now = Math.floor(Date.now() / 1000);
  const state = loadState();
  if (state && (now - state.last_trigger_at) < COOLDOWN_SECONDS) return;
  saveState({ last_trigger_at: now, used_percentage: usedPct, session_id: status.session_id });
  try {
    execFileSync('node', [C4_CONTROL, 'enqueue',
      '--content', `Context at ${usedPct}%. Run memory sync (if needed) then use the restart-claude skill to restart.`,
      '--priority', '3', '--require-idle', '--ack-deadline', '600'
    ], { encoding: 'utf8', stdio: 'pipe' });
    log(`Triggered restart: context at ${usedPct}%`);
  } catch (err) { log(`Failed to enqueue restart: ${err.message}`); }
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } }
function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function log(msg) {
  try {
    const logFile = path.join(ZYLOS_DIR, 'activity-monitor', 'context-monitor.log');
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
