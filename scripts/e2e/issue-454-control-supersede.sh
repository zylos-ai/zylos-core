#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

HOME_DIR="$TMP_DIR/home"
ZYLOS_DIR="$HOME_DIR/zylos"
CONTROL_SCRIPT="$ROOT_DIR/skills/comm-bridge/scripts/c4-control.js"
DISPATCHER_SCRIPT="$ROOT_DIR/skills/comm-bridge/scripts/c4-dispatcher.js"
BIN_DIR="$TMP_DIR/bin"
TMUX_LOG="$TMP_DIR/tmux.log"
DISPATCHER_LOG="$TMP_DIR/dispatcher.log"

mkdir -p "$ZYLOS_DIR/.zylos" "$ZYLOS_DIR/activity-monitor" "$BIN_DIR"

cat > "$ZYLOS_DIR/.zylos/config.json" <<'EOF'
{
  "runtime": "codex"
}
EOF

extract_id() {
  local output="$1"
  local id
  id="$(printf '%s\n' "$output" | sed -n 's/.*control \([0-9][0-9]*\).*/\1/p' | head -n 1)"
  if [ -z "$id" ]; then
    echo "failed to extract control id from output:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  printf '%s\n' "$id"
}

assert_file_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -Fq -- "$pattern" "$file"; then
    echo "missing expected pattern in $file: $pattern" >&2
    cat "$file" >&2 || true
    exit 1
  fi
}

cat > "$BIN_DIR/tmux" <<EOF
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="$TMUX_LOG"
BUFFER_FILE="$TMP_DIR/tmux-buffer.txt"

cmd="\${1:-}"
shift || true

case "\$cmd" in
  set-buffer)
    while [ "\$#" -gt 0 ]; do
      if [ "\$1" = "--" ]; then
        shift
        break
      fi
      shift
    done
    printf '%s' "\${1:-}" > "\$BUFFER_FILE"
    ;;
  paste-buffer)
    if [ -f "\$BUFFER_FILE" ]; then
      cat "\$BUFFER_FILE" >> "\$LOG_FILE"
      printf '\n' >> "\$LOG_FILE"
    fi
    ;;
  capture-pane)
    printf '%s\n%s\n' '────────────────────────────────────────' '────────────────────────────────────────'
    ;;
  send-keys|delete-buffer)
    ;;
  *)
    ;;
esac
EOF
chmod +x "$BIN_DIR/tmux"

echo "== repeated enqueue supersedes older pending control =="
FIRST_OUT="$(HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$CONTROL_SCRIPT" enqueue --content "dedupe me")"
SECOND_OUT="$(HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$CONTROL_SCRIPT" enqueue --content "dedupe me")"

FIRST_ID="$(extract_id "$FIRST_OUT")"
SECOND_ID="$(extract_id "$SECOND_OUT")"

if ! printf '%s\n' "$SECOND_OUT" | grep -Fq "OK: superseded 1 equivalent pending control(s)"; then
  echo "missing supersede log line in second enqueue output" >&2
  printf '%s\n' "$SECOND_OUT" >&2
  exit 1
fi

ROOT_DIR="$ROOT_DIR" FIRST_ID="$FIRST_ID" SECOND_ID="$SECOND_ID" HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(`${process.env.ROOT_DIR}/skills/comm-bridge/scripts/c4-db.js`).href;
const {
  getControlById,
  getNextPendingControl,
  claimControl,
  ackControl,
  close
} = await import(moduleUrl);

const firstId = Number(process.env.FIRST_ID);
const secondId = Number(process.env.SECOND_ID);

try {
  const first = getControlById(firstId);
  const second = getControlById(secondId);

  assert.equal(first.status, 'superseded');
  assert.equal(second.status, 'pending');

  const next = getNextPendingControl();
  assert.equal(next.id, secondId);

  assert.equal(claimControl(firstId), false);
  assert.equal(claimControl(secondId), true);
  assert.equal(getControlById(secondId).status, 'running');

  const supersededAck = ackControl(firstId);
  assert.equal(supersededAck.found, true);
  assert.equal(supersededAck.alreadyFinal, true);
  assert.equal(supersededAck.status, 'superseded');

  const runningAck = ackControl(secondId);
  assert.equal(runningAck.found, true);
  assert.equal(runningAck.alreadyFinal, false);
  assert.equal(runningAck.status, 'done');
  assert.equal(getControlById(secondId).status, 'done');
} finally {
  close();
}
EOF

echo "== dispatcher only delivers the newest pending control =="
NOW_SECS="$(date +%s)"
cat > "$ZYLOS_DIR/activity-monitor/agent-status.json" <<EOF
{
  "state": "idle",
  "health": "ok",
  "idle_seconds": 30
}
EOF
cat > "$ZYLOS_DIR/activity-monitor/proc-state.json" <<EOF
{
  "alive": true,
  "frozen": false,
  "lastSampleAt": $NOW_SECS,
  "lastDelta": 1
}
EOF

THIRD_OUT="$(HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$CONTROL_SCRIPT" enqueue --content "dispatch me")"
FOURTH_OUT="$(HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$CONTROL_SCRIPT" enqueue --content "dispatch me")"
THIRD_ID="$(extract_id "$THIRD_OUT")"
FOURTH_ID="$(extract_id "$FOURTH_OUT")"

PATH="$BIN_DIR:$PATH" HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$DISPATCHER_SCRIPT" >"$DISPATCHER_LOG" 2>&1 &
DISPATCHER_PID=$!
sleep 2
kill -TERM "$DISPATCHER_PID" 2>/dev/null || true
wait "$DISPATCHER_PID" 2>/dev/null || true

ROOT_DIR="$ROOT_DIR" THIRD_ID="$THIRD_ID" FOURTH_ID="$FOURTH_ID" HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(`${process.env.ROOT_DIR}/skills/comm-bridge/scripts/c4-db.js`).href;
const { getControlById, getNextPendingControl, close } = await import(moduleUrl);

const thirdId = Number(process.env.THIRD_ID);
const fourthId = Number(process.env.FOURTH_ID);

try {
  assert.equal(getControlById(thirdId).status, 'superseded');
  assert.equal(getControlById(fourthId).status, 'running');
  assert.equal(getNextPendingControl(), null);
} finally {
  close();
}
EOF

assert_file_contains "$DISPATCHER_LOG" "Delivering control id=$FOURTH_ID"
assert_file_contains "$TMUX_LOG" "Meanwhile, dispatch me"
if [ "$(grep -Fc 'Meanwhile, dispatch me' "$TMUX_LOG")" -ne 1 ]; then
  echo "dispatcher should have delivered exactly one deduped control" >&2
  cat "$TMUX_LOG" >&2 || true
  exit 1
fi
if grep -Fq "id=$THIRD_ID" "$DISPATCHER_LOG"; then
  echo "superseded control should not have been delivered by dispatcher" >&2
  cat "$DISPATCHER_LOG" >&2 || true
  exit 1
fi

echo "E2E OK"
