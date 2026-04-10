#!/usr/bin/env node
/**
 * Hook-based tool lifecycle recorder.
 *
 * Receives Claude Code hook events via stdin JSON and appends lifecycle
 * events to ~/zylos/activity-monitor/tool-events.jsonl. The activity monitor
 * merges this stream into foreground/background session state and derives the
 * external api-activity.json snapshot.
 *
 * Registered as an async hook on: UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, Stop, Notification(idle_prompt).
 *
 * Safety: writes are best-effort and fail-open. Hook failures must never
 * interfere with Claude.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findMatchingToolRule, summarizeToolInput } from './tool-rules.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const TOOL_EVENTS_FILE = path.join(MONITOR_DIR, 'tool-events.jsonl');
const HOOK_ERROR_LOG = path.join(MONITOR_DIR, 'hook-activity-errors.log');

function getClaudePid() {
  try {
    const status = fs.readFileSync(`/proc/${process.ppid}/status`, 'utf8');
    const match = status.match(/^PPid:\s*(\d+)/m);
    if (match) return Number.parseInt(match[1], 10);
  } catch {
    // Best-effort.
  }
  return process.ppid;
}

function appendError(message) {
  try {
    fs.appendFileSync(HOOK_ERROR_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Best-effort.
  }
}

function buildToolEvent({ hookData, eventName, claudePid, nowMs }) {
  const sessionId = hookData.session_id || process.env.CLAUDE_SESSION_ID || null;
  if (!sessionId) return null;

  const toolName = hookData.tool_name || null;
  const toolInput = hookData.tool_input || {};
  const rule = toolName
    ? findMatchingToolRule({ runtimeId: 'claude', toolName, toolInput, config: {} })
    : null;

  const base = {
    ts: nowMs,
    pid: claudePid,
    session_id: sessionId,
    event: eventName,
  };

  if (toolName) {
    base.tool = toolName;
  }

  if (eventName === 'pre_tool') {
    base.event_id = `evt_${nowMs}_${randomBytes(4).toString('hex')}`;
    base.summary = summarizeToolInput(toolName, toolInput);
    if (rule?.id) {
      base.rule_id = rule.id;
    }
  }

  return base;
}

function appendJsonLine(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function handleHookActivity(hookData, { nowMs = Date.now(), claudePid = getClaudePid() } = {}) {
  const hookEventName = hookData?.hook_event_name;

  let eventName = null;
  switch (hookEventName) {
    case 'UserPromptSubmit':
      eventName = 'prompt';
      break;
    case 'PreToolUse':
      eventName = 'pre_tool';
      break;
    case 'PostToolUse':
      eventName = 'post_tool';
      break;
    case 'PostToolUseFailure':
      eventName = 'post_tool_failure';
      break;
    case 'Stop':
      eventName = 'stop';
      break;
    case 'Notification':
      eventName = 'idle';
      break;
    default:
      return null;
  }

  const record = buildToolEvent({ hookData, eventName, claudePid, nowMs });
  if (!record) return null;

  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
  appendJsonLine(TOOL_EVENTS_FILE, record);
  return record;
}

if (process.env.HOOK_ACTIVITY_DISABLE_MAIN !== '1') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });

  process.stdin.on('end', () => {
    try {
      const hookData = JSON.parse(input || '{}');
      handleHookActivity(hookData);
    } catch (err) {
      appendError(err?.message || 'unknown_error');
    }
  });
}
