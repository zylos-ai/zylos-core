#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

HOME_DIR="$TMP_DIR/home"
ZYLOS_HOME="$HOME_DIR/zylos"
BIN_DIR="$TMP_DIR/bin"
PM2_LOG="$TMP_DIR/pm2.log"

mkdir -p "$ZYLOS_HOME/pm2" "$ZYLOS_HOME/activity-monitor" "$ZYLOS_HOME/.zylos" "$HOME_DIR/.codex" "$BIN_DIR"

cat > "$ZYLOS_HOME/pm2/ecosystem.config.cjs" <<'EOF'
module.exports = {
  apps: [
    { name: 'activity-monitor', script: 'activity-monitor.js' },
    { name: 'scheduler', script: 'scheduler.js' },
    { name: 'c4-dispatcher', script: 'c4-dispatcher.js' },
    { name: 'web-console', script: 'web-console.js' },
  ],
};
EOF

cat > "$ZYLOS_HOME/.zylos/config.json" <<'EOF'
{
  "runtime": "claude"
}
EOF

cat > "$HOME_DIR/.codex/auth.json" <<'EOF'
{
  "auth_mode": "chatgpt"
}
EOF

cat > "$BIN_DIR/pm2" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$PM2_LOG"
exit 0
EOF
chmod +x "$BIN_DIR/pm2"

cat > "$BIN_DIR/codex" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "login" ] && [ "${2:-}" = "status" ]; then
  exit 0
fi
exit 0
EOF
chmod +x "$BIN_DIR/codex"

export HOME="$HOME_DIR"
export PATH="$BIN_DIR:$PATH"

assert_log_contains() {
  local pattern="$1"
  if ! grep -Fq -- "$pattern" "$PM2_LOG"; then
    echo "missing expected PM2 log line: $pattern" >&2
    cat "$PM2_LOG" >&2 || true
    exit 1
  fi
}

assert_log_not_contains() {
  local pattern="$1"
  if grep -Fq -- "$pattern" "$PM2_LOG"; then
    echo "unexpected PM2 log line: $pattern" >&2
    cat "$PM2_LOG" >&2 || true
    exit 1
  fi
}

echo "== service restart =="
: > "$PM2_LOG"
node "$ROOT_DIR/cli/zylos.js" restart >/dev/null
assert_log_contains "start $ZYLOS_HOME/pm2/ecosystem.config.cjs --only activity-monitor"
assert_log_contains "start $ZYLOS_HOME/pm2/ecosystem.config.cjs --only scheduler"
assert_log_contains "start $ZYLOS_HOME/pm2/ecosystem.config.cjs --only c4-dispatcher"
assert_log_contains "start $ZYLOS_HOME/pm2/ecosystem.config.cjs --only web-console"
assert_log_contains "save"
assert_log_not_contains "restart activity-monitor"
assert_log_not_contains "restart scheduler"
assert_log_not_contains "restart c4-dispatcher"
assert_log_not_contains "restart web-console"

echo "== runtime switch =="
: > "$PM2_LOG"
node "$ROOT_DIR/cli/zylos.js" runtime codex >/dev/null
assert_log_contains "start $ZYLOS_HOME/pm2/ecosystem.config.cjs --only activity-monitor"
assert_log_contains "start $ZYLOS_HOME/pm2/ecosystem.config.cjs --only c4-dispatcher"
assert_log_not_contains "restart activity-monitor"
assert_log_not_contains "restart c4-dispatcher"

echo "== component rollback restart =="
: > "$PM2_LOG"
SKILL_DIR="$ZYLOS_HOME/.claude/skills/demo"
mkdir -p "$SKILL_DIR"
cat > "$SKILL_DIR/SKILL.md" <<'EOF'
---
name: demo
version: 0.1.0
lifecycle:
  service:
    name: zylos-demo
---
EOF
cat > "$SKILL_DIR/ecosystem.config.cjs" <<'EOF'
module.exports = { apps: [{ name: 'zylos-demo', script: 'index.js' }] };
EOF
node --input-type=module <<EOF >/dev/null
import { rollback } from '$ROOT_DIR/cli/lib/upgrade.js';

rollback({
  component: 'demo',
  skillDir: '$SKILL_DIR',
  backupDir: null,
  serviceWasRunning: true,
});
EOF
assert_log_contains "start $SKILL_DIR/ecosystem.config.cjs --only zylos-demo"
assert_log_not_contains "restart zylos-demo"

echo "E2E OK"
