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

assert_model() {
  local expected="$1"
  local actual
  actual="$(node --input-type=module <<EOF
import fs from 'node:fs';
const settings = JSON.parse(fs.readFileSync('$ZYLOS_DIR/.claude/settings.json', 'utf8'));
process.stdout.write(String(settings.model));
EOF
)"
  if [ "$actual" != "$expected" ]; then
    echo "expected model=$expected, got $actual" >&2
    exit 1
  fi
}

echo "== backfill missing model =="
cat > "$ZYLOS_DIR/.claude/settings.json" <<'EOF'
{
  "hooks": {}
}
EOF
HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$ROOT_DIR/cli/lib/sync-settings-hooks.js" >/dev/null
assert_model "opus"

echo "== preserve user model =="
cat > "$ZYLOS_DIR/.claude/settings.json" <<'EOF'
{
  "model": "sonnet",
  "hooks": {}
}
EOF
HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$ROOT_DIR/cli/lib/sync-settings-hooks.js" >/dev/null
assert_model "sonnet"

echo "E2E OK"
