#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
ORIGINAL_PATH="$PATH"
CASE_DIR=""
CASE_NAME=""
HOME_DIR=""
ZYLOS_DIR=""
BIN_DIR=""
MONITOR_PID=""
DISPATCHER_PID=""
declare -a BG_PIDS=()
declare -a LIVE_PIDS=()

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

require_comm_bridge_module() {
  local module_name="$1"
  MODULE_NAME="$module_name" ROOT_DIR="$ROOT_DIR" node --input-type=module <<'EOF'
import { createRequire } from 'node:module';
import path from 'node:path';
try {
  const require = createRequire(path.join(process.env.ROOT_DIR, 'skills', 'comm-bridge', 'package.json'));
  require.resolve(process.env.MODULE_NAME);
} catch (err) {
  console.error(`missing required module '${process.env.MODULE_NAME}': ${err.message}`);
  process.exit(1);
}
EOF
}

dump_case_artifacts() {
  if [ -z "${CASE_DIR:-}" ] || [ ! -d "${CASE_DIR:-}" ]; then
    return
  fi

  echo "== CASE: ${CASE_NAME:-unknown} ==" >&2
  for file in \
    "$CASE_DIR/tmux.log" \
    "$CASE_DIR/monitor.stdout.log" \
    "$CASE_DIR/dispatcher.stdout.log" \
    "$ZYLOS_DIR/activity-monitor/activity.log" \
    "$ZYLOS_DIR/activity-monitor/agent-status.json" \
    "$ZYLOS_DIR/activity-monitor/api-activity.json" \
    "$ZYLOS_DIR/activity-monitor/session-tool-state.json" \
    "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" \
    "$ZYLOS_DIR/activity-monitor/foreground-session.json" \
    "$ZYLOS_DIR/activity-monitor/tool-events.jsonl"; do
    if [ -f "$file" ]; then
      echo "---- $file ----" >&2
      sed -n '1,240p' "$file" >&2 || true
    fi
  done
}

cleanup_case() {
  for pid in "${BG_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${BG_PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  BG_PIDS=()
  MONITOR_PID=""
  DISPATCHER_PID=""

  for pid in "${LIVE_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${LIVE_PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  LIVE_PIDS=()
}

global_cleanup() {
  cleanup_case || true
  rm -rf "$TMP_ROOT"
}

on_error() {
  local line="$1"
  echo "E2E failure in case '${CASE_NAME:-unknown}' at line $line" >&2
  dump_case_artifacts
}

trap 'on_error $LINENO' ERR
trap global_cleanup EXIT

spawn_live_pid() {
  local __target_var="$1"
  sleep 1000 >/dev/null 2>&1 &
  local pid=$!
  LIVE_PIDS+=("$pid")
  printf -v "$__target_var" '%s' "$pid"
}

write_base_settings() {
  cat > "$ZYLOS_DIR/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js"
          }
        ]
      }
    ]
  }
}
EOF
}

write_config() {
  local timeout_sec="${1:-2}"
  local grace_sec="${2:-2}"
  local cooldown_sec="${3:-1}"
  cat > "$ZYLOS_DIR/.zylos/config.json" <<EOF
{
  "runtime": "claude",
  "heartbeat_enabled": false,
  "usage_monitor_enabled": false,
  "daily_upgrade_enabled": false,
  "web_tool_watchdog_enabled": true,
  "web_tool_timeout_sec": ${timeout_sec},
  "web_tool_interrupt_grace_sec": ${grace_sec},
  "web_tool_timeout_cooldown_sec": ${cooldown_sec}
}
EOF
}

write_initial_status() {
  local runtime_launch_at_ms="${1:-$(( $(now_ms) - 301000 ))}"
  local health="${2:-ok}"
  local state="${3:-idle}"
  RUNTIME_LAUNCH_AT_MS="$runtime_launch_at_ms" HEALTH="$health" STATE="$state" node --input-type=module <<'EOF'
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
const payload = {
  state: process.env.STATE,
  health: process.env.HEALTH,
  runtime_launch_at: Number(process.env.RUNTIME_LAUNCH_AT_MS),
  last_check: Math.floor(Date.now() / 1000),
  last_check_human: new Date().toISOString().replace('T', ' ').substring(0, 19),
  idle_seconds: process.env.STATE === 'idle' ? 60 : 0,
  inactive_seconds: process.env.STATE === 'idle' ? 60 : 0
};
fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
EOF
}

write_quiet_monitor_state() {
  node --input-type=module <<'EOF'
import fs from 'node:fs';
import path from 'node:path';

const monitorDir = path.join(process.env.ZYLOS_DIR, 'activity-monitor');
fs.mkdirSync(monitorDir, { recursive: true });
const now = Math.floor(Date.now() / 1000);
const today = new Date().toISOString().slice(0, 10);

const files = new Map([
  ['health-check-state.json', {
    last_check_at: now,
    last_check_human: new Date(now * 1000).toISOString().replace('T', ' ').substring(0, 19)
  }],
  ['daily-upgrade-state.json', { last_date: today, updated_at: new Date().toISOString() }],
  ['daily-memory-commit-state.json', { last_date: today, updated_at: new Date().toISOString() }],
  ['upgrade-check-state.json', { last_date: today, updated_at: new Date().toISOString() }]
]);

for (const [name, payload] of files.entries()) {
  fs.writeFileSync(path.join(monitorDir, name), `${JSON.stringify(payload, null, 2)}\n`);
}
EOF
}

write_fake_binaries() {
  cat > "$BIN_DIR/tmux" <<'EOF'
#!/usr/bin/env node
import fs from 'node:fs';

const stateFile = process.env.TMUX_STATE_FILE;
const logFile = process.env.TMUX_LOG_FILE;
const bufferFile = process.env.TMUX_BUFFER_FILE;

function loadState() {
  if (!fs.existsSync(stateFile)) {
    return { sessions: {}, desired_next_pane_pid: 0, desired_next_claude_pid: 0, fail_escape: false };
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function appendLog(message) {
  fs.appendFileSync(logFile, `${message}\n`);
}

function getTarget(args) {
  const idx = args.indexOf('-t');
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return 'claude-main';
}

function ensureSession(state, name) {
  if (!state.sessions[name]) {
    state.sessions[name] = {
      exists: false,
      pane_pid: 0,
      claude_pid: 0,
      cursor_x: 0,
      cursor_y: 0,
      capture: '',
      window_activity: 0,
    };
  }
  return state.sessions[name];
}

const args = process.argv.slice(2);
const cmd = args[0];
const state = loadState();

switch (cmd) {
  case 'has-session': {
    const session = ensureSession(state, getTarget(args));
    process.exit(session.exists ? 0 : 1);
  }
  case 'list-panes': {
    const session = ensureSession(state, getTarget(args));
    if (!session.exists) process.exit(1);
    process.stdout.write(`${session.pane_pid}\n`);
    break;
  }
  case 'list-windows': {
    const session = ensureSession(state, getTarget(args));
    if (!session.exists) process.exit(1);
    process.stdout.write(`${session.window_activity || 0}\n`);
    break;
  }
  case 'display-message': {
    const session = ensureSession(state, getTarget(args));
    if (!session.exists) process.exit(1);
    const format = args[args.length - 1] || '';
    if (format.includes('cursor_x')) {
      process.stdout.write(`${session.cursor_x ?? 0}\n`);
    } else if (format.includes('cursor_y')) {
      process.stdout.write(`${session.cursor_y ?? 0}\n`);
    } else {
      process.stdout.write('\n');
    }
    break;
  }
  case 'capture-pane': {
    const session = ensureSession(state, getTarget(args));
    if (!session.exists) process.exit(1);
    process.stdout.write(String(session.capture || ''));
    break;
  }
  case 'set-buffer':
  case 'load-buffer': {
    let content = '';
    if (cmd === 'set-buffer') {
      const sep = args.indexOf('--');
      content = sep >= 0 ? (args[sep + 1] || '') : '';
    } else {
      const file = args[args.length - 1];
      content = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    fs.writeFileSync(bufferFile, content);
    appendLog(`${cmd} ${content.replace(/\n/g, '\\n')}`);
    break;
  }
  case 'paste-buffer': {
    const sessionName = getTarget(args);
    const content = fs.existsSync(bufferFile) ? fs.readFileSync(bufferFile, 'utf8') : '';
    appendLog(`paste-buffer ${sessionName} ${content.replace(/\n/g, '\\n')}`);
    break;
  }
  case 'delete-buffer': {
    try { fs.unlinkSync(bufferFile); } catch {}
    appendLog('delete-buffer');
    break;
  }
  case 'send-keys': {
    const sessionName = getTarget(args);
    const key = args[args.length - 1] || '';
    appendLog(`send-keys ${sessionName} ${key}`);
    if (key === 'Escape' && state.fail_escape) {
      process.exit(1);
    }
    break;
  }
  case 'kill-session': {
    const sessionName = getTarget(args);
    const session = ensureSession(state, sessionName);
    session.exists = false;
    appendLog(`kill-session ${sessionName}`);
    saveState(state);
    break;
  }
  case 'new-session': {
    const idx = args.indexOf('-s');
    const sessionName = idx >= 0 ? args[idx + 1] : 'claude-main';
    const session = ensureSession(state, sessionName);
    session.exists = true;
    if (state.desired_next_pane_pid) session.pane_pid = state.desired_next_pane_pid;
    if (state.desired_next_claude_pid) session.claude_pid = state.desired_next_claude_pid;
    session.cursor_x = 0;
    session.cursor_y = 0;
    session.capture = 'launching';
    session.window_activity = Math.floor(Date.now() / 1000);
    state.desired_next_pane_pid = 0;
    state.desired_next_claude_pid = 0;
    appendLog(`new-session ${sessionName}`);
    saveState(state);
    break;
  }
  default:
    break;
}
EOF
  chmod +x "$BIN_DIR/tmux"

  cat > "$BIN_DIR/ps" <<'EOF'
#!/usr/bin/env node
import fs from 'node:fs';

const stateFile = process.env.TMUX_STATE_FILE;
const args = process.argv.slice(2);
const pidIdx = args.indexOf('-p');
const pid = pidIdx >= 0 ? Number(args[pidIdx + 1]) : 0;
if (!fs.existsSync(stateFile) || !pid) process.exit(1);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
for (const session of Object.values(state.sessions || {})) {
  if (Number(session?.claude_pid) === pid) {
    process.stdout.write('claude\n');
    process.exit(0);
  }
  if (Number(session?.pane_pid) === pid) {
    process.stdout.write('bash\n');
    process.exit(0);
  }
}
process.exit(1);
EOF
  chmod +x "$BIN_DIR/ps"

  cat > "$BIN_DIR/pgrep" <<'EOF'
#!/usr/bin/env node
import fs from 'node:fs';

const stateFile = process.env.TMUX_STATE_FILE;
const args = process.argv.slice(2);
if (!fs.existsSync(stateFile)) process.exit(1);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

if (args.includes('-P')) {
  const idx = args.indexOf('-P');
  const parent = Number(args[idx + 1]);
  for (const session of Object.values(state.sessions || {})) {
    if (session?.exists && Number(session?.pane_pid) === parent && Number(session?.claude_pid) > 0) {
      process.stdout.write(`${session.claude_pid}\n`);
      process.exit(0);
    }
  }
  process.exit(1);
}

process.exit(1);
EOF
  chmod +x "$BIN_DIR/pgrep"

  cat > "$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-p" ] && [ "${2:-}" = "ping" ]; then
  exit 0
fi
printf 'claude %s\n' "$*" >> "${FAKE_CLAUDE_LOG}"
exit 0
EOF
  chmod +x "$BIN_DIR/claude"
}

begin_case() {
  cleanup_case
  CASE_NAME="$1"
  CASE_DIR="$TMP_ROOT/$CASE_NAME"
  HOME_DIR="$CASE_DIR/home"
  ZYLOS_DIR="$HOME_DIR/zylos"
  BIN_DIR="$CASE_DIR/bin"
  mkdir -p "$HOME_DIR" "$ZYLOS_DIR/.zylos" "$ZYLOS_DIR/.claude" "$ZYLOS_DIR/activity-monitor" "$ZYLOS_DIR/comm-bridge" "$BIN_DIR"
  export HOME="$HOME_DIR"
  export ZYLOS_DIR="$ZYLOS_DIR"
  export ZYLOS_PACKAGE_ROOT="$ROOT_DIR"
  export PATH="$BIN_DIR:$ORIGINAL_PATH"
  export TMUX_STATE_FILE="$CASE_DIR/tmux-state.json"
  export TMUX_LOG_FILE="$CASE_DIR/tmux.log"
  export TMUX_BUFFER_FILE="$CASE_DIR/tmux-buffer.txt"
  export FAKE_CLAUDE_LOG="$CASE_DIR/claude.log"
  write_config
  write_base_settings
  write_initial_status
  write_quiet_monitor_state
  write_fake_binaries
  cat > "$TMUX_STATE_FILE" <<'EOF'
{
  "sessions": {
    "claude-main": {
      "exists": false,
      "pane_pid": 0,
      "claude_pid": 0,
      "cursor_x": 0,
      "cursor_y": 0,
      "capture": "",
      "window_activity": 0
    },
    "codex-main": {
      "exists": false,
      "pane_pid": 0,
      "claude_pid": 0,
      "cursor_x": 0,
      "cursor_y": 0,
      "capture": "",
      "window_activity": 0
    }
  },
  "desired_next_pane_pid": 0,
  "desired_next_claude_pid": 0,
  "fail_escape": false
}
EOF
  : > "$TMUX_LOG_FILE"
}

process_is_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

write_tmux_session() {
  local session_name="$1"
  local exists="$2"
  local pane_pid="$3"
  local claude_pid="$4"
  local cursor_x="$5"
  local cursor_y="$6"
  local capture="$7"
  local window_activity="${8:-0}"
  SESSION_NAME="$session_name" EXISTS="$exists" PANE_PID="$pane_pid" CLAUDE_PID="$claude_pid" CURSOR_X="$cursor_x" CURSOR_Y="$cursor_y" CAPTURE="$capture" WINDOW_ACTIVITY="$window_activity" \
    node --input-type=module <<'EOF'
import fs from 'node:fs';
const file = process.env.TMUX_STATE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = process.env.SESSION_NAME;
state.sessions[name] = {
  exists: process.env.EXISTS === '1',
  pane_pid: Number(process.env.PANE_PID),
  claude_pid: Number(process.env.CLAUDE_PID),
  cursor_x: Number(process.env.CURSOR_X),
  cursor_y: Number(process.env.CURSOR_Y),
  capture: process.env.CAPTURE,
  window_activity: Number(process.env.WINDOW_ACTIVITY)
};
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
EOF
}

set_desired_next_session() {
  local pane_pid="$1"
  local claude_pid="$2"
  NEXT_PANE_PID="$pane_pid" NEXT_CLAUDE_PID="$claude_pid" node --input-type=module <<'EOF'
import fs from 'node:fs';
const file = process.env.TMUX_STATE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.desired_next_pane_pid = Number(process.env.NEXT_PANE_PID);
state.desired_next_claude_pid = Number(process.env.NEXT_CLAUDE_PID);
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
EOF
}

set_fail_escape() {
  local value="$1"
  FAIL_ESCAPE="$value" node --input-type=module <<'EOF'
import fs from 'node:fs';
const file = process.env.TMUX_STATE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.fail_escape = process.env.FAIL_ESCAPE === '1';
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
EOF
}

set_tmux_capture_busy() {
  local session_name="${1:-claude-main}"
  local capture="${2:-Fetching...}"
  write_tmux_session "$session_name" 1 "$(get_tmux_value "$session_name" "pane_pid")" "$(get_tmux_value "$session_name" "claude_pid")" 0 0 "$capture" "$(date +%s)"
}

set_tmux_capture_prompt() {
  local session_name="${1:-claude-main}"
  local capture="${2:-header
❯ }"
  write_tmux_session "$session_name" 1 "$(get_tmux_value "$session_name" "pane_pid")" "$(get_tmux_value "$session_name" "claude_pid")" 2 1 "$capture" "$(date +%s)"
}

set_tmux_capture_prompt_busy() {
  local session_name="${1:-claude-main}"
  local capture="${2:-header
⎿  Fetching...
✻ Proofing...
❯ }"
  write_tmux_session "$session_name" 1 "$(get_tmux_value "$session_name" "pane_pid")" "$(get_tmux_value "$session_name" "claude_pid")" 2 3 "$capture" "$(date +%s)"
}

set_tmux_capture_usage_overlay() {
  local session_name="${1:-claude-main}"
  local capture='Settings: Status Config Usage
Esc to cancel'
  write_tmux_session "$session_name" 1 "$(get_tmux_value "$session_name" "pane_pid")" "$(get_tmux_value "$session_name" "claude_pid")" 0 0 "$capture" "$(date +%s)"
}

get_tmux_value() {
  local session_name="$1"
  local field="$2"
  SESSION_NAME="$session_name" FIELD="$field" node --input-type=module <<'EOF'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.env.TMUX_STATE_FILE, 'utf8'));
const session = state.sessions?.[process.env.SESSION_NAME] || {};
const value = session?.[process.env.FIELD];
process.stdout.write(String(value ?? ''));
EOF
}

send_session_start() {
  local session_id="$1"
  local claude_pid="$2"
  local observed_at="${3:-$(now_ms)}"
  SESSION_ID="$session_id" CLAUDE_PID="$claude_pid" OBSERVED_AT="$observed_at" ROOT_DIR="$ROOT_DIR" node --input-type=module <<'EOF'
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(`${process.env.ROOT_DIR}/skills/activity-monitor/scripts/session-foreground.js`).href);
const record = mod.handleSessionForeground(
  { session_id: process.env.SESSION_ID, source: 'startup' },
  { observedAt: Number(process.env.OBSERVED_AT), claudePid: Number(process.env.CLAUDE_PID) }
);
if (!record) process.exit(1);
EOF
}

send_hook_event() {
  local hook_event_name="$1"
  local session_id="$2"
  local tool_name="${3:-}"
  local claude_pid="$4"
  local now_ms_value="$5"
  local tool_input_json="${6-}"
  local tool_use_id="${7-}"
  if [ -z "$tool_input_json" ]; then
    tool_input_json='{}'
  fi
  HOOK_EVENT_NAME="$hook_event_name" SESSION_ID="$session_id" TOOL_NAME="$tool_name" CLAUDE_PID="$claude_pid" NOW_MS="$now_ms_value" TOOL_INPUT_JSON="$tool_input_json" TOOL_USE_ID="$tool_use_id" ROOT_DIR="$ROOT_DIR" \
    node --input-type=module <<'EOF'
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(`${process.env.ROOT_DIR}/skills/activity-monitor/scripts/hook-activity.js`).href);
const payload = {
  hook_event_name: process.env.HOOK_EVENT_NAME,
  session_id: process.env.SESSION_ID
};
if (process.env.TOOL_NAME) payload.tool_name = process.env.TOOL_NAME;
payload.tool_input = JSON.parse(process.env.TOOL_INPUT_JSON || '{}');
if (process.env.TOOL_USE_ID) payload.tool_use_id = process.env.TOOL_USE_ID;
const record = mod.handleHookActivity(payload, {
  nowMs: Number(process.env.NOW_MS),
  claudePid: Number(process.env.CLAUDE_PID)
});
if (!record) process.exit(1);
EOF
}

append_raw_event() {
  local event_json="$1"
  EVENT_JSON="$event_json" node --input-type=module <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.ZYLOS_DIR, 'activity-monitor', 'tool-events.jsonl');
fs.appendFileSync(file, `${process.env.EVENT_JSON}\n`, 'utf8');
EOF
}

write_statusline() {
  local session_id="$1"
  local mtime_ms="$2"
  SESSION_ID="$session_id" MTIME_MS="$mtime_ms" node --input-type=module <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.ZYLOS_DIR, 'activity-monitor', 'statusline.json');
fs.writeFileSync(file, `${JSON.stringify({ session_id: process.env.SESSION_ID }, null, 2)}\n`);
const when = Number(process.env.MTIME_MS) / 1000;
fs.utimesSync(file, when, when);
EOF
}

json_expr_true() {
  local file="$1"
  local expr="$2"
  FILE="$file" EXPR="$expr" node --input-type=module <<'EOF'
import fs from 'node:fs';
if (!fs.existsSync(process.env.FILE)) process.exit(1);
const data = JSON.parse(fs.readFileSync(process.env.FILE, 'utf8'));
const fn = new Function('data', `return (${process.env.EXPR});`);
try {
  process.exit(fn(data) ? 0 : 1);
} catch {
  process.exit(1);
}
EOF
}

assert_json_expr() {
  local file="$1"
  local expr="$2"
  if ! json_expr_true "$file" "$expr"; then
    echo "JSON assertion failed: $file :: $expr" >&2
    dump_case_artifacts
    exit 1
  fi
}

control_contains() {
  local pattern="$1"
  local db_path="$ZYLOS_DIR/comm-bridge/c4.db"
  DB_PATH="$db_path" PATTERN="$pattern" ROOT_DIR="$ROOT_DIR" node --input-type=module <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const dbPath = process.env.DB_PATH;
if (!fs.existsSync(dbPath)) process.exit(1);
const require = createRequire(path.join(process.env.ROOT_DIR, 'skills', 'comm-bridge', 'package.json'));
const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });
const like = `%${process.env.PATTERN}%`;
const row = db.prepare(`
  SELECT COUNT(*) AS count
  FROM control_queue
  WHERE content LIKE ? OR raw_content LIKE ? OR COALESCE(last_error, '') LIKE ?
`).get(like, like, like);
db.close();
process.exit((row?.count || 0) > 0 ? 0 : 1);
EOF
}

tmux_log_contains() {
  local pattern="$1"
  grep -Fq -- "$pattern" "$TMUX_LOG_FILE"
}

tmux_log_not_contains() {
  local pattern="$1"
  if grep -Fq -- "$pattern" "$TMUX_LOG_FILE"; then
    return 1
  fi
  return 0
}

wait_until() {
  local timeout="$1"
  local description="$2"
  shift 2
  local start
  start="$(date +%s)"
  while true; do
    if "$@"; then
      return 0
    fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      echo "timeout waiting for: $description" >&2
      dump_case_artifacts
      return 1
    fi
    sleep 0.2
  done
}

start_monitor() {
  ROOT_DIR="$ROOT_DIR" HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" ZYLOS_PACKAGE_ROOT="$ROOT_DIR" PATH="$BIN_DIR:$PATH" TMUX_STATE_FILE="$TMUX_STATE_FILE" TMUX_LOG_FILE="$TMUX_LOG_FILE" TMUX_BUFFER_FILE="$TMUX_BUFFER_FILE" FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" \
    node "$ROOT_DIR/skills/activity-monitor/scripts/activity-monitor.js" >"$CASE_DIR/monitor.stdout.log" 2>&1 &
  MONITOR_PID=$!
  BG_PIDS+=("$MONITOR_PID")
  sleep 0.3
  wait_until 8 "activity-monitor booted" process_is_running "$MONITOR_PID"
  wait_until 8 "agent-status written" test -f "$ZYLOS_DIR/activity-monitor/agent-status.json"
}

start_dispatcher() {
  ROOT_DIR="$ROOT_DIR" HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" ZYLOS_PACKAGE_ROOT="$ROOT_DIR" PATH="$BIN_DIR:$PATH" TMUX_STATE_FILE="$TMUX_STATE_FILE" TMUX_LOG_FILE="$TMUX_LOG_FILE" TMUX_BUFFER_FILE="$TMUX_BUFFER_FILE" FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" \
    node "$ROOT_DIR/skills/comm-bridge/scripts/c4-dispatcher.js" >"$CASE_DIR/dispatcher.stdout.log" 2>&1 &
  DISPATCHER_PID=$!
  BG_PIDS+=("$DISPATCHER_PID")
  sleep 0.3
  wait_until 8 "dispatcher booted" process_is_running "$DISPATCHER_PID"
}

tc_001_escape_delivery() {
  begin_case "tc-e2e-001"
  local pane_pid claude_pid ts_now ts_prompt ts_tool
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 0 0 "Fetching..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 6000))"
  ts_tool="$((ts_now - 5000))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_tool" '{"url":"https://webcache.googleusercontent.com/test"}'
  wait_until 10 "watchdog interrupt sent" json_expr_true "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" 'data.interrupt_sent_at > 0'
  wait_until 10 "control queue contains Escape" control_contains "[KEYSTROKE]Escape"
  wait_until 10 "tmux received Escape" tmux_log_contains "send-keys claude-main Escape"
  assert_json_expr "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.watchdog_candidate_tool && data.watchdog_candidate_tool.name === "WebFetch"'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/session-tool-state.json" 'Array.isArray(data.sessions["fg-1"].running_tools) && data.sessions["fg-1"].running_tools.length === 1'
  if ! tmux_log_not_contains "kill-session claude-main"; then
    echo "unexpected kill-session during tc-e2e-001" >&2
    dump_case_artifacts
    exit 1
  fi
}

tc_002_normal_completion_skips_watchdog() {
  begin_case "tc-e2e-002"
  write_config 2 2 1
  local pane_pid claude_pid ts_now ts_prompt ts_tool ts_done
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 0 0 "Working..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 1200))"
  ts_tool="$((ts_now - 800))"
  ts_done="$((ts_now - 200))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_tool" '{"url":"https://example.com/ok"}' "toolu_ok_1"
  send_hook_event "PostToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_done" '{"url":"https://example.com/ok"}' "toolu_ok_1"
  wait_until 8 "normal completion clears active tools" json_expr_true "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.active_tools === 0 && data.last_completed_tool && data.last_completed_tool.event_id === "toolu_ok_1" && data.last_completed_tool.status === "success"'
  if [ -f "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" ]; then
    echo "watchdog state should not exist for tc-e2e-002" >&2
    dump_case_artifacts
    exit 1
  fi
  if ! tmux_log_not_contains "send-keys claude-main Escape"; then
    echo "unexpected tmux Escape during tc-e2e-002" >&2
    dump_case_artifacts
    exit 1
  fi
  if ! tmux_log_not_contains "kill-session claude-main"; then
    echo "unexpected kill-session during tc-e2e-002" >&2
    dump_case_artifacts
    exit 1
  fi
}

tc_003_synthetic_clear() {
  begin_case "tc-e2e-003"
  local pane_pid claude_pid ts_now ts_prompt ts_tool
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 0 0 "Fetching..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 6000))"
  ts_tool="$((ts_now - 5000))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_tool" '{"url":"https://example.com/stuck"}'
  wait_until 10 "tmux received Escape" tmux_log_contains "send-keys claude-main Escape"
  set_tmux_capture_prompt "claude-main" $'header\n❯ '
  wait_until 10 "api activity cleared after prompt recovery" json_expr_true "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.active_tools === 0'
  if [ -f "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" ]; then
    echo "watchdog state should have been cleared in tc-e2e-003" >&2
    dump_case_artifacts
    exit 1
  fi
  assert_json_expr "$ZYLOS_DIR/activity-monitor/session-tool-state.json" 'data.sessions["fg-1"].last_completed_tool && data.sessions["fg-1"].last_completed_tool.status === "cleared_by_session_event"'
  if ! tmux_log_not_contains "kill-session claude-main"; then
    echo "unexpected kill-session during tc-e2e-003" >&2
    dump_case_artifacts
    exit 1
  fi
}

tc_004_busy_prompt_blocks_clear() {
  begin_case "tc-e2e-004"
  write_config 2 5 1
  local pane_pid claude_pid ts_now ts_prompt ts_tool
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 2 3 $'header\n⎿  Fetching...\n✻ Sketching...\n❯ ' "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 6000))"
  ts_tool="$((ts_now - 5000))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_tool" '{"url":"https://example.com/still-fetching"}'
  write_statusline "fg-1" "$(now_ms)"
  wait_until 10 "watchdog interrupt sent while prompt is still busy" json_expr_true "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" 'data.interrupt_sent_at > 0'
  sleep 1
  assert_json_expr "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.active_tools === 1 && data.watchdog_candidate_tool && data.watchdog_candidate_tool.name === "WebFetch"'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/session-tool-state.json" 'Array.isArray(data.sessions["fg-1"].running_tools) && data.sessions["fg-1"].running_tools.length === 1'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/session-tool-state.json" '!data.sessions["fg-1"].last_completed_tool || data.sessions["fg-1"].last_completed_tool.clear_reason !== "statusline_turn_complete"'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/session-tool-state.json" '!data.sessions["fg-1"].last_completed_tool || data.sessions["fg-1"].last_completed_tool.clear_reason !== "interactive_recovered"'
}

tc_010_recent_statusline_does_not_override_real_completion() {
  begin_case "tc-e2e-010"
  write_config 10 2 1
  local pane_pid claude_pid ts_now ts_prompt ts_tool ts_status ts_done
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 2 1 $'header\n❯ ' "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 5000))"
  ts_tool="$((ts_now - 3500))"
  ts_status="$((ts_now - 3000))"
  ts_done="$((ts_now - 1500))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_tool" '{"url":"https://example.com/status-race"}' "toolu_status_race"
  write_statusline "fg-1" "$ts_status"
  wait_until 8 "recent statusline does not clear the active tool" json_expr_true "$ZYLOS_DIR/activity-monitor/session-tool-state.json" 'data.sessions && data.sessions["fg-1"] && Array.isArray(data.sessions["fg-1"].running_tools) && data.sessions["fg-1"].running_tools.length === 1 && (!data.sessions["fg-1"].last_completed_tool || data.sessions["fg-1"].last_completed_tool.clear_reason !== "statusline_turn_complete")'
  send_hook_event "PostToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_done" '{"url":"https://example.com/status-race"}' "toolu_status_race"
  wait_until 8 "real completion wins over statusline hint" json_expr_true "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.active_tools === 0 && data.last_completed_tool && data.last_completed_tool.event_id === "toolu_status_race" && data.last_completed_tool.status === "success" && data.last_completed_tool.clear_reason !== "statusline_turn_complete"'
  if [ -f "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" ]; then
    echo "watchdog state should not exist for tc-e2e-010" >&2
    dump_case_artifacts
    exit 1
  fi
  if ! tmux_log_not_contains "send-keys claude-main Escape"; then
    echo "unexpected tmux Escape during tc-e2e-010" >&2
    dump_case_artifacts
    exit 1
  fi
}

tc_007_concurrent_same_name_completions_match_by_tool_use_id() {
  begin_case "tc-e2e-007"
  write_config 10 2 1
  local pane_pid claude_pid ts_now ts_prompt ts_first ts_second ts_done_first ts_done_second
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 0 0 "Working..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 7000))"
  ts_first="$((ts_now - 6000))"
  ts_second="$((ts_now - 5000))"
  ts_done_first="$((ts_now - 4000))"
  ts_done_second="$((ts_now - 3000))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_first" '{"url":"https://example.com/a"}' "toolu_a"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_second" '{"url":"https://example.com/b"}' "toolu_b"
  wait_until 8 "two active webfetch tools visible" json_expr_true "$ZYLOS_DIR/activity-monitor/session-tool-state.json" 'data.sessions && data.sessions["fg-1"] && Array.isArray(data.sessions["fg-1"].running_tools) && data.sessions["fg-1"].running_tools.length === 2'
  send_hook_event "PostToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_done_first" '{"url":"https://example.com/a"}' "toolu_a"
  wait_until 8 "older completion leaves newer tool active" json_expr_true "$ZYLOS_DIR/activity-monitor/session-tool-state.json" 'data.sessions && data.sessions["fg-1"] && data.sessions["fg-1"].last_completed_tool && data.sessions["fg-1"].last_completed_tool.event_id === "toolu_a" && Array.isArray(data.sessions["fg-1"].running_tools) && data.sessions["fg-1"].running_tools.length === 1 && data.sessions["fg-1"].running_tools[0].event_id === "toolu_b"'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.watchdog_candidate_tool && data.watchdog_candidate_tool.event_id === "toolu_b"'
  send_hook_event "PostToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_done_second" '{"url":"https://example.com/b"}' "toolu_b"
  wait_until 8 "second completion clears session" json_expr_true "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.active_tools === 0 && data.last_completed_tool && data.last_completed_tool.event_id === "toolu_b" && data.last_completed_tool.status === "success"'
  if ! tmux_log_not_contains "send-keys claude-main Escape"; then
    echo "unexpected tmux Escape during tc-e2e-007" >&2
    dump_case_artifacts
    exit 1
  fi
}

tc_008_sequential_same_name_handoff() {
  begin_case "tc-e2e-008"
  write_config 3 2 1
  local pane_pid claude_pid ts_now ts_prompt ts_first ts_done_first ts_second
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 0 0 "Working..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 7000))"
  ts_first="$((ts_now - 6000))"
  ts_done_first="$((ts_now - 5000))"
  ts_second="$((ts_now - 4000))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_first" '{"url":"https://example.com/first"}' "toolu_first"
  send_hook_event "PostToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_done_first" '{"url":"https://example.com/first"}' "toolu_first"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_second" '{"url":"https://example.com/second"}' "toolu_second"
  wait_until 8 "second webfetch becomes active candidate" json_expr_true "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.active_tools === 1 && data.watchdog_candidate_tool && data.watchdog_candidate_tool.event_id === "toolu_second" && data.last_completed_tool && data.last_completed_tool.event_id === "toolu_first"'
  wait_until 10 "sequential second tool times out" json_expr_true "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" 'data.episode_key === "toolu_second" && data.interrupt_sent_at > 0'
  wait_until 10 "tmux received Escape for sequential second tool" tmux_log_contains "send-keys claude-main Escape"
}

tc_005_escalates_to_restart() {
  begin_case "tc-e2e-005"
  local pane_pid claude_pid ts_now ts_prompt ts_tool
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 0 0 "Fetching..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  ts_prompt="$((ts_now - 6000))"
  ts_tool="$((ts_now - 5000))"
  send_hook_event "UserPromptSubmit" "fg-1" "" "$claude_pid" "$ts_prompt" "{}"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$ts_tool" '{"url":"https://example.com/escalate"}'
  wait_until 12 "watchdog escalated" json_expr_true "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" 'data.escalated_at > 0'
  wait_until 12 "tmux kill-session observed" tmux_log_contains "kill-session claude-main"
  assert_json_expr "$ZYLOS_DIR/activity-monitor/agent-status.json" 'data.watchdog_phase === "escalated"'
}

tc_006_foreground_background_isolation() {
  begin_case "tc-e2e-006"
  local fg_pane fg_claude bg_claude ts_now
  spawn_live_pid fg_pane
  spawn_live_pid fg_claude
  spawn_live_pid bg_claude
  write_tmux_session "claude-main" 1 "$fg_pane" "$fg_claude" 0 0 "Working..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$fg_claude"
  ts_now="$(now_ms)"
  send_hook_event "PreToolUse" "fg-1" "Bash" "$fg_claude" "$((ts_now - 5000))" '{"command":"sleep 60"}'
  send_hook_event "PreToolUse" "bg-1" "WebFetch" "$bg_claude" "$((ts_now - 5000))" '{"url":"https://example.com/background"}'
  sleep 4
  assert_json_expr "$ZYLOS_DIR/activity-monitor/session-tool-state.json" 'data.sessions["fg-1"] && data.sessions["bg-1"]'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.sessionId === "fg-1"'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.watchdog_candidate_tool === null'
  if control_contains "[KEYSTROKE]Escape"; then
    echo "unexpected Escape control for background-only stuck tool" >&2
    dump_case_artifacts
    exit 1
  fi
}

tc_009_old_pid_late_events() {
  begin_case "tc-e2e-009"
  local old_pane old_claude new_pane new_claude ts_now
  spawn_live_pid old_pane
  spawn_live_pid old_claude
  write_tmux_session "claude-main" 1 "$old_pane" "$old_claude" 0 0 "Fetching..." "$(date +%s)"
  start_monitor
  send_session_start "fg-old" "$old_claude"
  ts_now="$(now_ms)"
  send_hook_event "UserPromptSubmit" "fg-old" "" "$old_claude" "$((ts_now - 6000))" "{}"
  send_hook_event "PreToolUse" "fg-old" "WebFetch" "$old_claude" "$((ts_now - 5000))" '{"url":"https://example.com/old"}'
  wait_until 12 "old session escalated" json_expr_true "$ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" 'data.escalated_at > 0'
  wait_until 12 "old session killed" tmux_log_contains "kill-session claude-main"

  spawn_live_pid new_pane
  spawn_live_pid new_claude
  set_desired_next_session "$new_pane" "$new_claude"
  wait_until 12 "new tmux session created" tmux_log_contains "new-session claude-main"

  send_session_start "fg-new" "$new_claude"
  ts_now="$(now_ms)"
  send_hook_event "PreToolUse" "fg-new" "WebFetch" "$new_claude" "$((ts_now - 5000))" '{"url":"https://example.com/new"}'
  wait_until 10 "new session active tool visible" json_expr_true "$ZYLOS_DIR/activity-monitor/agent-status.json" 'data.active_tool_session_id === "fg-new"'

  send_hook_event "PostToolUse" "fg-old" "WebFetch" "$old_claude" "$(( $(now_ms) - 3000 ))" '{}'
  send_hook_event "Notification" "fg-old" "" "$old_claude" "$(( $(now_ms) - 2500 ))" '{}'
  sleep 3

  assert_json_expr "$ZYLOS_DIR/activity-monitor/agent-status.json" 'data.active_tool_session_id === "fg-new"'
  assert_json_expr "$ZYLOS_DIR/activity-monitor/api-activity.json" 'data.sessionId === "fg-new" && data.watchdog_candidate_tool && data.watchdog_candidate_tool.name === "WebFetch"'
}

tc_012_launch_grace_blocks_watchdog() {
  begin_case "tc-e2e-012"
  local pane_pid claude_pid ts_now
  write_initial_status "$(now_ms)" "ok" "idle"
  spawn_live_pid pane_pid
  spawn_live_pid claude_pid
  write_tmux_session "claude-main" 1 "$pane_pid" "$claude_pid" 0 0 "Fetching..." "$(date +%s)"
  start_monitor
  start_dispatcher
  send_session_start "fg-1" "$claude_pid"
  ts_now="$(now_ms)"
  send_hook_event "PreToolUse" "fg-1" "WebFetch" "$claude_pid" "$((ts_now - 5000))" '{"url":"https://example.com/launch-grace"}'
  wait_until 8 "launch grace block visible" json_expr_true "$ZYLOS_DIR/activity-monitor/agent-status.json" 'data.watchdog_block_reason === "launch_grace"'
  sleep 4
  if control_contains "[KEYSTROKE]Escape"; then
    echo "unexpected Escape control during launch grace" >&2
    dump_case_artifacts
    exit 1
  fi
  if ! tmux_log_not_contains "send-keys claude-main Escape"; then
    echo "unexpected tmux Escape during launch grace" >&2
    dump_case_artifacts
    exit 1
  fi
}

require_comm_bridge_module "better-sqlite3"

echo "== tc-e2e-001 =="
tc_001_escape_delivery

echo "== tc-e2e-002 =="
tc_002_normal_completion_skips_watchdog

echo "== tc-e2e-003 =="
tc_003_synthetic_clear

echo "== tc-e2e-004 =="
tc_004_busy_prompt_blocks_clear

echo "== tc-e2e-005 =="
tc_005_escalates_to_restart

echo "== tc-e2e-006 =="
tc_006_foreground_background_isolation

echo "== tc-e2e-007 =="
tc_007_concurrent_same_name_completions_match_by_tool_use_id

echo "== tc-e2e-008 =="
tc_008_sequential_same_name_handoff

echo "== tc-e2e-009 =="
tc_009_old_pid_late_events

echo "== tc-e2e-010 =="
tc_010_recent_statusline_does_not_override_real_completion

echo "== tc-e2e-012 =="
tc_012_launch_grace_blocks_watchdog

echo "E2E OK"
