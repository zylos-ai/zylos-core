#!/usr/bin/env node
/**
 * Hook-based activity tracker — replaces fetch-preload.cjs
 *
 * Receives Claude Code hook events via stdin JSON, writes activity state
 * to ~/zylos/activity-monitor/api-activity.json so the activity monitor
 * can detect busy/idle/stuck states in real time.
 *
 * Registered as an async hook on: UserPromptSubmit, PreToolUse,
 * PostToolUse, Stop, Notification(idle_prompt).
 *
 * Safety: all writes are best-effort. Failures are silently ignored
 * to never interfere with Claude.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const ACTIVITY_FILE = path.join(MONITOR_DIR, 'api-activity.json');
const STATE_FILE = path.join(MONITOR_DIR, 'hook-state.json');

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* best-effort */ }
  return { active_tools: 0 };
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp);
      }
    } catch { /* best-effort */ }
    throw err;
  }
}

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    const event = hookData.hook_event_name;
    const state = readState();

    let eventType, active, tool = null;

    switch (event) {
      case 'UserPromptSubmit':
        eventType = 'prompt';
        active = true;
        state.active_tools = 0;
        break;
      case 'PreToolUse':
        eventType = 'pre_tool';
        tool = hookData.tool_name || null;
        state.active_tools = Math.max(0, state.active_tools) + 1;
        active = true;
        break;
      case 'PostToolUse':
        eventType = 'post_tool';
        tool = hookData.tool_name || null;
        state.active_tools = Math.max(0, state.active_tools - 1);
        active = state.active_tools > 0;
        break;
      case 'Stop':
        eventType = 'stop';
        state.active_tools = 0;
        active = false;
        break;
      case 'Notification':
        eventType = 'idle';
        state.active_tools = 0;
        active = false;
        break;
      default:
        process.exit(0);
    }

    if (!fs.existsSync(MONITOR_DIR)) {
      fs.mkdirSync(MONITOR_DIR, { recursive: true });
    }

    atomicWrite(ACTIVITY_FILE, {
      version: 2,
      pid: process.ppid,
      sessionId: process.env.CLAUDE_SESSION_ID || String(process.ppid),
      event: eventType,
      tool,
      active,
      active_tools: state.active_tools,
      updated_at: Date.now()
    });

    atomicWrite(STATE_FILE, state);
  } catch {
    // Best-effort — never interfere with Claude.
  }
});
