#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# Zylos Docker Entrypoint
#
# 1. Validates required auth environment variables
# 2. Runs zylos init (creates/updates .env and workspace — every startup)
# 3. Passes through channel env vars to .env
# 4. Starts PM2 services
# 5. Starts Claude Code inside a persistent tmux session
# 6. Keeps container alive via PM2 --no-daemon
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ZYLOS_DIR="${HOME}/zylos"
ENV_FILE="${ZYLOS_DIR}/.env"

# ── Colour helpers ────────────────────────────────────────────────────────────
info()  { echo -e "\033[0;36m[zylos]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[zylos]\033[0m $*"; }
error() { echo -e "\033[0;31m[zylos]\033[0m $*" >&2; }

info "Starting Zylos ($(zylos --version 2>/dev/null || echo 'dev'))..."

# ── Validate auth ─────────────────────────────────────────────────────────────
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # Check mounted .env as fallback
  if ! grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' "${ENV_FILE}" 2>/dev/null; then
    error "No auth configured. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN."
    exit 1
  fi
fi

# ── Workspace initialisation via zylos init ───────────────────────────────────
# zylos init handles: directory structure, .env creation from template,
# auth credential storage, timezone config, PM2 ecosystem, web console password.
# It uses upsert semantics — safe to re-run (won't overwrite existing values).
# Runs every startup (no marker) so template files stay in sync after image upgrades.
info "Running zylos init..."

# Resolve auth token — auto-detect type regardless of which env var it's in
AUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
AUTH_FLAG=""
if [ -n "${AUTH_TOKEN}" ]; then
  if [[ "${AUTH_TOKEN}" == sk-ant-oat* ]]; then
    AUTH_FLAG="--setup-token ${AUTH_TOKEN}"
  else
    AUTH_FLAG="--api-key ${AUTH_TOKEN}"
  fi
fi

# Build init flags
INIT_ARGS="--yes --quiet"
[ -n "${TZ:-}" ] && INIT_ARGS="${INIT_ARGS} --timezone ${TZ}"
[ -n "${AUTH_FLAG}" ] && INIT_ARGS="${INIT_ARGS} ${AUTH_FLAG}"

# shellcheck disable=SC2086
if ! zylos init ${INIT_ARGS}; then
  warn "zylos init exited with errors (may be partial). Check logs."
fi

info "Workspace ready."

# ── Pass through channel env vars to .env ─────────────────────────────────────
# zylos init doesn't write channel tokens — those come from component installs.
# In Docker, we pass them via environment and append to .env here (upsert).
upsert_env() {
  local key="$1" value="$2"
  [ -z "${value}" ] && return
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    # Update existing value — env vars from docker-compose take precedence
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}" 2>/dev/null || true
  else
    echo "${key}=${value}" >> "${ENV_FILE}" 2>/dev/null || true
  fi
}

upsert_env "TELEGRAM_BOT_TOKEN" "${TELEGRAM_BOT_TOKEN:-}"
upsert_env "LARK_APP_ID" "${LARK_APP_ID:-}"
upsert_env "LARK_APP_SECRET" "${LARK_APP_SECRET:-}"
upsert_env "WEB_CONSOLE_BIND" "${WEB_CONSOLE_BIND:-0.0.0.0}"
upsert_env "CLAUDE_BYPASS_PERMISSIONS" "${CLAUDE_BYPASS_PERMISSIONS:-true}"

# Save current PATH so PM2 services can find claude and node
upsert_env "SYSTEM_PATH" "${PATH}"

# ── Graceful shutdown ─────────────────────────────────────────────────────────
# docker stop sends SIGTERM to PID 1 (this script). Clean up tmux + PM2.
SHUTTING_DOWN=false
cleanup() {
  [ "${SHUTTING_DOWN}" = true ] && return
  SHUTTING_DOWN=true
  info "Shutting down..."
  tmux kill-session -t claude-main 2>/dev/null || true
  pm2 kill 2>/dev/null || true
  # Kill the PM2 --no-daemon process directly in case pm2 kill didn't stop it
  [ -n "${PM2_PID:-}" ] && kill "${PM2_PID}" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Start PM2 services ────────────────────────────────────────────────────────
info "Starting PM2 services..."
pm2 start "${ZYLOS_DIR}/pm2/ecosystem.config.cjs" --no-daemon &
PM2_PID=$!

# Give PM2 a moment to spin up core services before starting Claude
sleep 3

# ── Start Claude Code in tmux ─────────────────────────────────────────────────
info "Starting Claude Code session (tmux: claude-main)..."

# Kill any stale session
tmux kill-session -t claude-main 2>/dev/null || true

# Build claude command
CLAUDE_ARGS=""
if [ "${CLAUDE_BYPASS_PERMISSIONS:-true}" = "true" ]; then
  CLAUDE_ARGS="--dangerously-skip-permissions"
fi

tmux new-session -d -s claude-main -x 220 -y 50 \
  "cd ${HOME} && source ${ENV_FILE} 2>/dev/null; exec claude ${CLAUDE_ARGS}"

info "Claude Code session started."

# ── Keep container alive ──────────────────────────────────────────────────────
# Use a sleep loop instead of waiting on PM2 directly.
# Bash interrupts sleep (not wait on a child) reliably on SIGTERM,
# allowing the trap handler to fire and exit cleanly.
info "All services started. Monitoring PM2..."
while kill -0 "${PM2_PID}" 2>/dev/null; do
  sleep 1
done
info "PM2 exited unexpectedly."
cleanup
