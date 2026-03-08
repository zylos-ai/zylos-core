#!/bin/bash
set -e

if [ ! -f /root/zylos/.env ]; then
  echo "[zylos-docker] First run, initializing..."
  if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    zylos init --yes --setup-token "$CLAUDE_CODE_OAUTH_TOKEN"
  elif [ -n "$ANTHROPIC_API_KEY" ]; then
    zylos init --yes --api-key "$ANTHROPIC_API_KEY"
  else
    echo "[zylos-docker] ERROR: Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"
    exit 1
  fi
  # Patch web-console to listen on all interfaces
  WC_SERVER="/root/zylos/.claude/skills/web-console/scripts/server.js"
  if [ -f "$WC_SERVER" ]; then
    sed -i "s/|| '127.0.0.1'/|| '0.0.0.0'/" "$WC_SERVER"
    npx pm2 restart web-console 2>/dev/null || true
  fi
else
  echo "[zylos-docker] Starting services..."
  cd /root/zylos && npx pm2 resurrect 2>/dev/null || zylos start
fi

echo "[zylos-docker] Zylos is running. Web console on port 3456."
exec tail -f /dev/null
