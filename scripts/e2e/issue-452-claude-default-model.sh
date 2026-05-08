#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

HOME_DIR="$TMP_DIR/home"
ZYLOS_DIR="$HOME_DIR/zylos"

mkdir -p "$HOME_DIR" "$ZYLOS_DIR/.claude" "$ZYLOS_DIR/.zylos"

cat > "$ZYLOS_DIR/.zylos/config.json" <<'EOF'
{
  "runtime": "claude"
}
EOF

assert_setting() {
  local key="$1"
  local expected="$2"
  local actual
  actual="$(node --input-type=module <<EOF
import fs from 'node:fs';
const settings = JSON.parse(fs.readFileSync('$ZYLOS_DIR/.claude/settings.json', 'utf8'));
process.stdout.write(String(settings['$key']));
EOF
)"
  if [ "$actual" != "$expected" ]; then
    echo "expected $key=$expected, got $actual" >&2
    exit 1
  fi
}

assert_model() {
  assert_setting "model" "$1"
}

echo "== backfill missing model =="
cat > "$ZYLOS_DIR/.claude/settings.json" <<'EOF'
{
  "hooks": {}
}
EOF
HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$ROOT_DIR/cli/lib/sync-settings-hooks.js" >/dev/null
assert_model "claude-opus-4-6"

echo "== preserve user model =="
cat > "$ZYLOS_DIR/.claude/settings.json" <<'EOF'
{
  "model": "sonnet",
  "hooks": {}
}
EOF
HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$ROOT_DIR/cli/lib/sync-settings-hooks.js" >/dev/null
assert_model "sonnet"

echo "== backfill missing autoMemoryEnabled and autoDreamEnabled =="
cat > "$ZYLOS_DIR/.claude/settings.json" <<'EOF'
{
  "hooks": {}
}
EOF
HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$ROOT_DIR/cli/lib/sync-settings-hooks.js" >/dev/null
assert_setting "autoMemoryEnabled" "false"
assert_setting "autoDreamEnabled" "false"

echo "== preserve user-configured autoMemoryEnabled =="
cat > "$ZYLOS_DIR/.claude/settings.json" <<'EOF'
{
  "autoMemoryEnabled": true,
  "autoDreamEnabled": true,
  "hooks": {}
}
EOF
HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$ROOT_DIR/cli/lib/sync-settings-hooks.js" >/dev/null
assert_setting "autoMemoryEnabled" "true"
assert_setting "autoDreamEnabled" "true"

echo "E2E OK"
