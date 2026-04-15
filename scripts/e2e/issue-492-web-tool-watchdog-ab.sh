#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MAIN_REF="main"
MAIN_WORKTREE=""
ARTIFACT_DIR=""
LIVE_ZYLOS_DIR="/home/ac/zylos"
SESSION_NAME="claude-main"
HANG_PORT="8894"
PUBLIC_URL=""
TIMEOUT_SEC="15"
GRACE_SEC="5"
COOLDOWN_SEC="2"
RUN_REPO_TESTS="1"
KEEP_MAIN_WORKTREE="0"

LIVE_CLAUDE_DIR=""
MAIN_SOURCE_DIR=""
SUMMARY_FILE=""
LT_LOG=""
HANG_LOG=""
LT_PID=""
HANG_SERVER_PID=""
STARTED_LOCALTUNNEL="0"
STARTED_HANG_SERVER="0"
REUSED_HANG_SERVER="0"
CREATED_MAIN_WORKTREE="0"
CURRENT_VARIANT=""
FAIL_MESSAGE=""

usage() {
  cat <<'EOF'
Usage: bash scripts/e2e/issue-492-web-tool-watchdog-ab.sh [options]

Run a real main-vs-current-worktree A/B validation for the WebFetch watchdog
against a dedicated local Zylos instance.

This script:
1. creates a detached worktree at <main-ref>
2. optionally runs skills/activity-monitor npm tests on main and current
3. deploys main into ~/zylos, runs live normal/hang cases, captures evidence
4. deploys the current workspace into ~/zylos, reruns the same cases
5. prints a summary and leaves ~/zylos on the current workspace deploy

Options:
  --main-ref <ref>           Git ref to use as baseline (default: main)
  --main-worktree <path>     Reuse an existing main worktree instead of creating one
  --artifacts-dir <path>     Directory for logs and snapshots
  --zylos-dir <path>         Live Zylos home (default: /home/ac/zylos)
  --session-name <name>      tmux session name (default: claude-main)
  --hang-port <port>         Hang server port (default: 8894)
  --public-url <url>         Reuse an existing public HTTPS URL instead of starting localtunnel
  --timeout-sec <sec>        watchdog timeout for live validation (default: 15)
  --grace-sec <sec>          watchdog interrupt grace (default: 5)
  --cooldown-sec <sec>       watchdog enqueue retry cooldown (default: 2)
  --skip-repo-tests          Skip skills/activity-monitor npm test on main/current
  --keep-main-worktree       Do not remove the temporary main worktree on exit
  -h, --help                 Show this help

Assumptions:
  - ~/zylos is a dedicated test environment
  - PM2 has activity-monitor and c4-dispatcher processes
  - runtime is Claude, so the tmux session is usually claude-main
  - if --public-url is omitted, npx localtunnel is available
EOF
}

log() {
  printf '[issue-492-ab] %s\n' "$*"
}

fail() {
  FAIL_MESSAGE="$*"
  printf '[issue-492-ab] ERROR: %s\n' "$*" >&2
  exit 1
}

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

line_count() {
  local file="$1"
  if [ -f "$file" ]; then
    wc -l <"$file" | tr -d ' '
  else
    printf '0\n'
  fi
}

save_new_lines() {
  local file="$1"
  local start_line="$2"
  local out="$3"
  if [ ! -f "$file" ]; then
    : >"$out"
    return
  fi
  sed -n "$((start_line + 1)),\$p" "$file" >"$out"
}

json_field() {
  local file="$1"
  local field="$2"
  local fallback="${3:-}"
  JSON_FILE="$file" JSON_FIELD="$field" JSON_FALLBACK="$fallback" node --input-type=module <<'EOF'
import fs from 'node:fs';

const fallback = process.env.JSON_FALLBACK ?? '';
try {
  const data = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const value = process.env.JSON_FIELD
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), data);
  process.stdout.write(value === undefined || value === null ? fallback : String(value));
} catch {
  process.stdout.write(fallback);
}
EOF
}

write_test_config() {
  ZYLOS_DIR="$LIVE_ZYLOS_DIR" TIMEOUT_SEC="$TIMEOUT_SEC" GRACE_SEC="$GRACE_SEC" COOLDOWN_SEC="$COOLDOWN_SEC" node --input-type=module <<'EOF'
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.ZYLOS_DIR, '.zylos', 'config.json');
let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}

data.runtime = data.runtime || 'claude';
data.web_tool_watchdog_enabled = true;
data.web_tool_timeout_sec = Number(process.env.TIMEOUT_SEC);
data.web_tool_interrupt_grace_sec = Number(process.env.GRACE_SEC);
data.web_tool_timeout_cooldown_sec = Number(process.env.COOLDOWN_SEC);

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
EOF
}

wait_for_tmux_session() {
  local timeout_sec="$1"
  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < timeout_sec )); do
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      return 0
    fi
    local detected
    detected="$(tmux list-sessions -F '#S' 2>/dev/null | sed -n '1p')"
    if [ -n "$detected" ]; then
      SESSION_NAME="$detected"
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_agent_online() {
  local timeout_sec="$1"
  local status_file="$LIVE_ZYLOS_DIR/activity-monitor/agent-status.json"
  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < timeout_sec )); do
    local state
    state="$(json_field "$status_file" "state" "")"
    if [ -n "$state" ] && [ "$state" != "offline" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rewind_launch_grace() {
  local status_file="$LIVE_ZYLOS_DIR/activity-monitor/agent-status.json"
  pm2 stop activity-monitor >/dev/null
  STATUS_FILE="$status_file" node --input-type=module <<'EOF'
import fs from 'node:fs';

const file = process.env.STATUS_FILE;
let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}
const now = Date.now();
data.runtime_launch_at = now - 301000;
data.last_check = Math.floor(now / 1000);
data.last_check_human = new Date(now).toISOString().replace('T', ' ').substring(0, 19);
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
EOF
  pm2 start activity-monitor >/dev/null

  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < 30 )); do
    local state block
    state="$(json_field "$status_file" "state" "")"
    block="$(json_field "$status_file" "watchdog_block_reason" "")"
    if [ -n "$state" ] && [ "$state" != "offline" ] && [ "$block" != "launch_grace" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_main_worktree() {
  if [ -n "$MAIN_WORKTREE" ]; then
    MAIN_SOURCE_DIR="$MAIN_WORKTREE"
    return
  fi

  MAIN_WORKTREE="$(mktemp -d /tmp/issue-492-main-XXXXXX)"
  git -C "$ROOT_DIR" worktree add --detach "$MAIN_WORKTREE" "$MAIN_REF" >/dev/null
  MAIN_SOURCE_DIR="$MAIN_WORKTREE"
  CREATED_MAIN_WORKTREE="1"
}

ensure_artifacts_dir() {
  if [ -z "$ARTIFACT_DIR" ]; then
    ARTIFACT_DIR="$(mktemp -d /tmp/issue-492-ab-XXXXXX)"
  else
    mkdir -p "$ARTIFACT_DIR"
  fi
  SUMMARY_FILE="$ARTIFACT_DIR/summary.txt"
  LT_LOG="$ARTIFACT_DIR/localtunnel.log"
  HANG_LOG="$ARTIFACT_DIR/hang-server.log"
}

write_metadata() {
  git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD >"$ARTIFACT_DIR/current-branch.txt"
  git -C "$ROOT_DIR" rev-parse HEAD >"$ARTIFACT_DIR/current-head.txt"
  git -C "$ROOT_DIR" rev-parse "$MAIN_REF" >"$ARTIFACT_DIR/main-head.txt"
  git -C "$ROOT_DIR" status --short >"$ARTIFACT_DIR/current-status.txt"
  git -C "$ROOT_DIR" diff --name-only "$MAIN_REF"...HEAD >"$ARTIFACT_DIR/main-vs-head.diff.txt"
}

ensure_hang_server() {
  if curl -fsS "http://127.0.0.1:${HANG_PORT}/healthz" >/dev/null 2>&1; then
    REUSED_HANG_SERVER="1"
    log "reusing existing hang server on 127.0.0.1:${HANG_PORT}"
    return
  fi

  node "$ROOT_DIR/scripts/e2e/issue-492-webfetch-hang-server.js" --port "$HANG_PORT" --quiet >"$HANG_LOG" 2>&1 &
  HANG_SERVER_PID="$!"
  STARTED_HANG_SERVER="1"

  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < 15 )); do
    if curl -fsS "http://127.0.0.1:${HANG_PORT}/healthz" >/dev/null 2>&1; then
      log "started hang server on 127.0.0.1:${HANG_PORT}"
      return
    fi
    sleep 1
  done
  fail "hang server did not become healthy on port ${HANG_PORT}"
}

ensure_public_url() {
  if [ -n "$PUBLIC_URL" ]; then
    return
  fi

  : >"$LT_LOG"
  npx --yes localtunnel --port "$HANG_PORT" --print-requests >"$LT_LOG" 2>&1 &
  LT_PID="$!"
  STARTED_LOCALTUNNEL="1"

  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < 30 )); do
    local url
    url="$(sed -n 's/^your url is: //p' "$LT_LOG" | tail -n 1)"
    if [ -n "$url" ]; then
      PUBLIC_URL="$url"
      log "started localtunnel: $PUBLIC_URL"
      return
    fi
    sleep 1
  done
  fail "localtunnel did not report a public URL"
}

deploy_variant() {
  local source_dir="$1"
  local variant="$2"
  CURRENT_VARIANT="$variant"
  log "deploying ${variant} from ${source_dir}"

  mkdir -p "$LIVE_CLAUDE_DIR/skills/activity-monitor/scripts" "$LIVE_CLAUDE_DIR/skills/comm-bridge/scripts"
  cp "$source_dir/templates/.claude/settings.json" "$LIVE_CLAUDE_DIR/settings.json"
  find "$LIVE_CLAUDE_DIR/skills/activity-monitor/scripts" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  find "$LIVE_CLAUDE_DIR/skills/comm-bridge/scripts" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$source_dir/skills/activity-monitor/scripts/." "$LIVE_CLAUDE_DIR/skills/activity-monitor/scripts/"
  cp -a "$source_dir/skills/comm-bridge/scripts/." "$LIVE_CLAUDE_DIR/skills/comm-bridge/scripts/"

  write_test_config
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  pm2 restart c4-dispatcher >/dev/null
  pm2 restart activity-monitor >/dev/null

  wait_for_tmux_session 90 || fail "${variant}: tmux session ${SESSION_NAME} did not appear"
  wait_for_agent_online 90 || fail "${variant}: activity-monitor never reported online"
  rewind_launch_grace || fail "${variant}: failed to bypass launch grace"
}

pane_capture() {
  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    local detected
    detected="$(tmux list-sessions -F '#S' 2>/dev/null | sed -n '1p')"
    if [ -n "$detected" ]; then
      SESSION_NAME="$detected"
    fi
  fi
  tmux capture-pane -pt "${SESSION_NAME}:0.0" 2>/dev/null || true
}

send_prompt() {
  local prompt="$1"
  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    local detected
    detected="$(tmux list-sessions -F '#S' 2>/dev/null | sed -n '1p')"
    if [ -n "$detected" ]; then
      SESSION_NAME="$detected"
    fi
  fi
  tmux send-keys -t "${SESSION_NAME}:0.0" C-u
  tmux send-keys -t "${SESSION_NAME}:0.0" -l -- "$prompt"
  tmux send-keys -t "${SESSION_NAME}:0.0" Enter
}

wait_for_pane_contains() {
  local needle="$1"
  local timeout_sec="$2"
  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < timeout_sec )); do
    if pane_capture | grep -Fq -- "$needle"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_new_file_contains() {
  local file="$1"
  local start_line="$2"
  local needle="$3"
  local timeout_sec="$4"
  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < timeout_sec )); do
    if [ -f "$file" ] && sed -n "$((start_line + 1)),\$p" "$file" | grep -Fq -- "$needle"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

active_request_count() {
  local json
  json="$(curl -fsS "http://127.0.0.1:${HANG_PORT}/active" 2>/dev/null || printf '{}')"
  ACTIVE_JSON="$json" node --input-type=module <<'EOF'
const payload = JSON.parse(process.env.ACTIVE_JSON || '{}');
process.stdout.write(String(Array.isArray(payload.active_requests) ? payload.active_requests.length : 0));
EOF
}

wait_for_active_count() {
  local expected="$1"
  local timeout_sec="$2"
  local start_sec="$SECONDS"
  while (( SECONDS - start_sec < timeout_sec )); do
    local count
    count="$(active_request_count)"
    if [ "$count" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

save_snapshot() {
  local out_dir="$1"
  local events_line="$2"
  local activity_line="$3"
  local lt_line="$4"

  mkdir -p "$out_dir"
  pane_capture >"$out_dir/pane.txt"
  save_new_lines "$LIVE_ZYLOS_DIR/activity-monitor/tool-events.jsonl" "$events_line" "$out_dir/tool-events.new.jsonl"
  save_new_lines "$LIVE_ZYLOS_DIR/activity-monitor/activity.log" "$activity_line" "$out_dir/activity.new.log"
  if [ -f "$LT_LOG" ]; then
    save_new_lines "$LT_LOG" "$lt_line" "$out_dir/localtunnel.new.log"
  else
    : >"$out_dir/localtunnel.new.log"
  fi
  curl -fsS "http://127.0.0.1:${HANG_PORT}/active" >"$out_dir/active.json" 2>/dev/null || printf '{}\n' >"$out_dir/active.json"

  for file in \
    "$LIVE_ZYLOS_DIR/activity-monitor/agent-status.json" \
    "$LIVE_ZYLOS_DIR/activity-monitor/api-activity.json" \
    "$LIVE_ZYLOS_DIR/activity-monitor/session-tool-state.json" \
    "$LIVE_ZYLOS_DIR/activity-monitor/tool-watchdog-state.json" \
    "$LIVE_ZYLOS_DIR/activity-monitor/tool-events.jsonl" \
    "$LIVE_ZYLOS_DIR/activity-monitor/activity.log"; do
    if [ -f "$file" ]; then
      cp "$file" "$out_dir/$(basename "$file")"
    fi
  done
}

assert_feature_normal_events() {
  local file="$1"
  EVENTS_FILE="$file" node --input-type=module <<'EOF'
import fs from 'node:fs';

const raw = fs.existsSync(process.env.EVENTS_FILE) ? fs.readFileSync(process.env.EVENTS_FILE, 'utf8') : '';
const lines = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const pre = lines.find((event) => event.event === 'pre_tool' && event.tool === 'WebFetch');
if (!pre) {
  console.error('missing WebFetch pre_tool');
  process.exit(1);
}
const post = lines.find((event) => event.event === 'post_tool' && event.tool === 'WebFetch' && event.event_id === pre.event_id);
if (!post) {
  console.error('missing matching WebFetch post_tool');
  process.exit(1);
}
EOF
}

assert_api_last_completed_success() {
  local file="$1"
  JSON_FILE="$file" node --input-type=module <<'EOF'
import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
const tool = data.last_completed_tool;
if (!tool || tool.status !== 'success') {
  console.error(`expected last_completed_tool.status=success, got ${tool ? tool.status : 'missing'}`);
  process.exit(1);
}
if (tool.clear_reason) {
  console.error(`expected no clear_reason for success case, got ${tool.clear_reason}`);
  process.exit(1);
}
EOF
}

assert_api_interactive_recovered() {
  local file="$1"
  JSON_FILE="$file" node --input-type=module <<'EOF'
import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
const tool = data.last_completed_tool;
if (!tool) {
  console.error('missing last_completed_tool');
  process.exit(1);
}
if (tool.status !== 'cleared_by_session_event') {
  console.error(`expected status=cleared_by_session_event, got ${tool.status}`);
  process.exit(1);
}
if (tool.clear_reason !== 'interactive_recovered') {
  console.error(`expected clear_reason=interactive_recovered, got ${tool.clear_reason}`);
  process.exit(1);
}
EOF
}

run_activity_monitor_tests() {
  local source_dir="$1"
  local variant="$2"
  local out_file="$ARTIFACT_DIR/${variant}.activity-monitor.npm-test.log"
  log "running skills/activity-monitor npm test for ${variant}"
  (
    cd "$source_dir/skills/activity-monitor"
    npm test
  ) >"$out_file" 2>&1 || fail "${variant}: skills/activity-monitor npm test failed (see $out_file)"
  printf '%s: skills/activity-monitor npm test PASS\n' "$variant" >>"$SUMMARY_FILE"
}

run_main_normal_case() {
  local out_dir="$ARTIFACT_DIR/main/normal"
  local events_line activity_line lt_line
  events_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/tool-events.jsonl")"
  activity_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/activity.log")"
  lt_line="$(line_count "$LT_LOG")"

  send_prompt "Use WebFetch to read ${PUBLIC_URL}/healthz and reply with exactly OK if the JSON field ok is true, otherwise FAIL. Do not use Bash or any fallback tool."
  wait_for_pane_contains "Received 67 bytes (200 OK)" 60 || fail "main normal: Claude never received the /healthz response"
  wait_for_pane_contains "● OK" 20 || fail "main normal: Claude never replied OK"
  if [ -f "$LT_LOG" ]; then
    wait_for_new_file_contains "$LT_LOG" "$lt_line" "GET /healthz" 30 || fail "main normal: tunnel did not observe GET /healthz"
  fi

  save_snapshot "$out_dir" "$events_line" "$activity_line" "$lt_line"
  printf 'main normal: PASS (Claude fetched /healthz and replied OK)\n' >>"$SUMMARY_FILE"
}

run_main_hang_case() {
  local out_dir="$ARTIFACT_DIR/main/hang"
  local events_line activity_line lt_line
  local observe_sec
  observe_sec="$((TIMEOUT_SEC + GRACE_SEC + 5))"
  events_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/tool-events.jsonl")"
  activity_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/activity.log")"
  lt_line="$(line_count "$LT_LOG")"

  send_prompt "Use WebFetch to read ${PUBLIC_URL}/hang/body and summarize the page in one short sentence. Do not use Bash or any fallback tool."
  wait_for_pane_contains "Fetching" 20 || fail "main hang: Claude never entered Fetching"
  sleep "$observe_sec"

  pane_capture >"$out_dir.pane.tmp"
  if ! grep -Fq "Fetching" "$out_dir.pane.tmp"; then
    rm -f "$out_dir.pane.tmp"
    fail "main hang: fetch was not still pending after ${observe_sec}s"
  fi
  rm -f "$out_dir.pane.tmp"

  if [ -f "$LT_LOG" ]; then
    wait_for_new_file_contains "$LT_LOG" "$lt_line" "GET /hang/body" 10 || fail "main hang: tunnel did not observe GET /hang/body"
  fi
  if [ "$(active_request_count)" -lt 1 ]; then
    fail "main hang: hang server no longer had an active request"
  fi
  if sed -n "$((activity_line + 1)),\$p" "$LIVE_ZYLOS_DIR/activity-monitor/activity.log" | grep -Fq 'Tool watchdog: sent Escape for WebFetch'; then
    fail "main hang: watchdog unexpectedly fired on baseline"
  fi

  tmux send-keys -t "${SESSION_NAME}:0.0" Escape
  wait_for_active_count "0" 15 || fail "main hang: manual Escape did not clear the active request"
  wait_for_pane_contains "Interrupted · What should Claude do instead?" 15 || fail "main hang: Claude did not show Interrupted after manual Escape"

  save_snapshot "$out_dir" "$events_line" "$activity_line" "$lt_line"
  printf 'main hang: PASS (no auto watchdog recovery within %ss; manual Escape still works)\n' "$observe_sec" >>"$SUMMARY_FILE"
}

run_feat_normal_case() {
  local out_dir="$ARTIFACT_DIR/feat/normal"
  local events_line activity_line lt_line
  events_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/tool-events.jsonl")"
  activity_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/activity.log")"
  lt_line="$(line_count "$LT_LOG")"

  send_prompt "Use WebFetch to read ${PUBLIC_URL}/healthz and reply with exactly OK if the JSON field ok is true, otherwise FAIL. Do not use Bash or any fallback tool."
  wait_for_pane_contains "Received 67 bytes (200 OK)" 60 || fail "feat normal: Claude never received the /healthz response"
  wait_for_pane_contains "● OK" 20 || fail "feat normal: Claude never replied OK"
  if [ -f "$LT_LOG" ]; then
    wait_for_new_file_contains "$LT_LOG" "$lt_line" "GET /healthz" 30 || fail "feat normal: tunnel did not observe GET /healthz"
  fi

  save_snapshot "$out_dir" "$events_line" "$activity_line" "$lt_line"
  assert_feature_normal_events "$out_dir/tool-events.new.jsonl"
  assert_api_last_completed_success "$out_dir/api-activity.json"
  if [ -f "$out_dir/tool-watchdog-state.json" ]; then
    fail "feat normal: tool-watchdog-state.json should not exist for a successful request"
  fi
  printf 'feat normal: PASS (success path preserved; no watchdog residue)\n' >>"$SUMMARY_FILE"
}

run_feat_hang_case() {
  local out_dir="$ARTIFACT_DIR/feat/hang"
  local events_line activity_line lt_line
  local observe_sec
  observe_sec="$((TIMEOUT_SEC + GRACE_SEC + 10))"
  events_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/tool-events.jsonl")"
  activity_line="$(line_count "$LIVE_ZYLOS_DIR/activity-monitor/activity.log")"
  lt_line="$(line_count "$LT_LOG")"

  send_prompt "Use WebFetch to read ${PUBLIC_URL}/hang/body and summarize the page in one short sentence. Do not use Bash or any fallback tool."
  wait_for_pane_contains "Fetching" 20 || fail "feat hang: Claude never entered Fetching"
  if [ -f "$LT_LOG" ]; then
    wait_for_new_file_contains "$LT_LOG" "$lt_line" "GET /hang/body" 15 || fail "feat hang: tunnel did not observe GET /hang/body"
  fi
  wait_for_new_file_contains "$LIVE_ZYLOS_DIR/activity-monitor/activity.log" "$activity_line" "Tool watchdog: sent Escape for WebFetch" "$observe_sec" || fail "feat hang: watchdog did not send Escape within ${observe_sec}s"
  wait_for_pane_contains "Interrupted · What should Claude do instead?" 20 || fail "feat hang: Claude did not show Interrupted after watchdog"
  wait_for_active_count "0" 20 || fail "feat hang: active request was not cleared after watchdog"

  save_snapshot "$out_dir" "$events_line" "$activity_line" "$lt_line"
  assert_api_interactive_recovered "$out_dir/api-activity.json"
  printf 'feat hang: PASS (watchdog interrupted hung WebFetch and recovered interactively)\n' >>"$SUMMARY_FILE"
}

best_effort_restore_feature() {
  if [ "$CURRENT_VARIANT" = "feat" ]; then
    return
  fi
  set +e
  log "best-effort restore: redeploying current workspace into ${LIVE_ZYLOS_DIR}"
  mkdir -p "$LIVE_CLAUDE_DIR/skills/activity-monitor/scripts" "$LIVE_CLAUDE_DIR/skills/comm-bridge/scripts"
  cp "$ROOT_DIR/templates/.claude/settings.json" "$LIVE_CLAUDE_DIR/settings.json"
  find "$LIVE_CLAUDE_DIR/skills/activity-monitor/scripts" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  find "$LIVE_CLAUDE_DIR/skills/comm-bridge/scripts" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$ROOT_DIR/skills/activity-monitor/scripts/." "$LIVE_CLAUDE_DIR/skills/activity-monitor/scripts/"
  cp -a "$ROOT_DIR/skills/comm-bridge/scripts/." "$LIVE_CLAUDE_DIR/skills/comm-bridge/scripts/"
  write_test_config
  pm2 restart c4-dispatcher >/dev/null 2>&1 || true
  pm2 restart activity-monitor >/dev/null 2>&1 || true
  set -e
}

cleanup() {
  local exit_code="$1"
  set +e

  if [ "$exit_code" -ne 0 ]; then
    best_effort_restore_feature
  fi

  if [ "$STARTED_LOCALTUNNEL" = "1" ] && [ -n "$LT_PID" ]; then
    kill "$LT_PID" 2>/dev/null || true
    wait "$LT_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_HANG_SERVER" = "1" ] && [ -n "$HANG_SERVER_PID" ]; then
    kill "$HANG_SERVER_PID" 2>/dev/null || true
    wait "$HANG_SERVER_PID" 2>/dev/null || true
  fi
  if [ "$CREATED_MAIN_WORKTREE" = "1" ] && [ "$KEEP_MAIN_WORKTREE" != "1" ] && [ -n "$MAIN_WORKTREE" ]; then
    git -C "$ROOT_DIR" worktree remove --force "$MAIN_WORKTREE" >/dev/null 2>&1 || true
  fi

  if [ -n "$ARTIFACT_DIR" ]; then
    log "artifacts: $ARTIFACT_DIR"
  fi
  if [ "$exit_code" -ne 0 ] && [ -n "$FAIL_MESSAGE" ]; then
    log "failure: $FAIL_MESSAGE"
  fi
}

trap 'cleanup $?' EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --main-ref)
      MAIN_REF="${2:?missing value for --main-ref}"
      shift 2
      ;;
    --main-worktree)
      MAIN_WORKTREE="${2:?missing value for --main-worktree}"
      shift 2
      ;;
    --artifacts-dir)
      ARTIFACT_DIR="${2:?missing value for --artifacts-dir}"
      shift 2
      ;;
    --zylos-dir)
      LIVE_ZYLOS_DIR="${2:?missing value for --zylos-dir}"
      shift 2
      ;;
    --session-name)
      SESSION_NAME="${2:?missing value for --session-name}"
      shift 2
      ;;
    --hang-port)
      HANG_PORT="${2:?missing value for --hang-port}"
      shift 2
      ;;
    --public-url)
      PUBLIC_URL="${2:?missing value for --public-url}"
      shift 2
      ;;
    --timeout-sec)
      TIMEOUT_SEC="${2:?missing value for --timeout-sec}"
      shift 2
      ;;
    --grace-sec)
      GRACE_SEC="${2:?missing value for --grace-sec}"
      shift 2
      ;;
    --cooldown-sec)
      COOLDOWN_SEC="${2:?missing value for --cooldown-sec}"
      shift 2
      ;;
    --skip-repo-tests)
      RUN_REPO_TESTS="0"
      shift
      ;;
    --keep-main-worktree)
      KEEP_MAIN_WORKTREE="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

LIVE_CLAUDE_DIR="$LIVE_ZYLOS_DIR/.claude"
ensure_artifacts_dir
write_metadata
ensure_main_worktree

log "artifacts will be written to $ARTIFACT_DIR"
log "baseline ref: $MAIN_REF"
log "current workspace: $ROOT_DIR"

if [ "$RUN_REPO_TESTS" = "1" ]; then
  run_activity_monitor_tests "$MAIN_SOURCE_DIR" "main"
  run_activity_monitor_tests "$ROOT_DIR" "feat"
else
  printf 'repo tests: SKIPPED\n' >>"$SUMMARY_FILE"
fi

ensure_hang_server
ensure_public_url

printf 'public url: %s\n' "$PUBLIC_URL" >>"$SUMMARY_FILE"
printf 'watchdog config: timeout=%ss grace=%ss cooldown=%ss\n' "$TIMEOUT_SEC" "$GRACE_SEC" "$COOLDOWN_SEC" >>"$SUMMARY_FILE"

deploy_variant "$MAIN_SOURCE_DIR" "main"
run_main_normal_case
run_main_hang_case

deploy_variant "$ROOT_DIR" "feat"
run_feat_normal_case
run_feat_hang_case

CURRENT_VARIANT="feat"
log "A/B validation complete"
printf '\n'
cat "$SUMMARY_FILE"
