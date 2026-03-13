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
ok()    { echo -e "\033[0;32m[zylos]\033[0m ✓ $*"; }
warn()  { echo -e "\033[1;33m[zylos]\033[0m $*"; }
error() { echo -e "\033[0;31m[zylos]\033[0m $*" >&2; }
step()  { echo -e "\033[0;36m[zylos]\033[0m ── Step $1/$TOTAL_STEPS: $2"; }

TOTAL_STEPS=4
ZYLOS_VERSION="$(zylos --version 2>/dev/null || echo 'dev')"

echo ""
info "=========================================="
info "  Zylos ${ZYLOS_VERSION}"
info "=========================================="
echo ""

# ── Step 1: Validate auth ─────────────────────────────────────────────────────
step 1 "Checking authentication..."
# Accept Anthropic credentials (Claude runtime) OR OpenAI/Codex credentials (Codex runtime).
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && \
   [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${CODEX_API_KEY:-}" ]; then
  # Check mounted .env as fallback
  if ! grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)=' "${ENV_FILE}" 2>/dev/null; then
    error "No auth configured. Set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN (Claude) or OPENAI_API_KEY / CODEX_API_KEY (Codex)."
    exit 1
  fi
fi
ok "Authentication configured"

# ── Step 2: Workspace initialisation via zylos init ───────────────────────────
# zylos init handles: directory structure, .env creation from template,
# auth credential storage, timezone config, PM2 ecosystem, web console password.
# It uses upsert semantics — safe to re-run (won't overwrite existing values).
# Runs every startup (no marker) so template files stay in sync after image upgrades.
step 2 "Initializing workspace..."

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

# Detect runtime — if only Codex credentials are present (no Claude creds), default to codex.
# ZYLOS_RUNTIME env var always wins when explicitly set.
RUNTIME_FLAG=""
if [ -z "${ZYLOS_RUNTIME:-}" ]; then
  HAS_CLAUDE_AUTH=false
  HAS_CODEX_AUTH=false
  [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && HAS_CLAUDE_AUTH=true
  [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] && HAS_CODEX_AUTH=true
  if [ "${HAS_CODEX_AUTH}" = true ] && [ "${HAS_CLAUDE_AUTH}" = false ]; then
    RUNTIME_FLAG="--runtime codex"
  fi
fi

# Build init flags
INIT_ARGS="--yes --quiet"
[ -n "${TZ:-}" ] && INIT_ARGS="${INIT_ARGS} --timezone ${TZ}"
[ -n "${AUTH_FLAG}" ] && INIT_ARGS="${INIT_ARGS} ${AUTH_FLAG}"
[ -n "${RUNTIME_FLAG}" ] && INIT_ARGS="${INIT_ARGS} ${RUNTIME_FLAG}"

# shellcheck disable=SC2086
if ! zylos init ${INIT_ARGS}; then
  warn "zylos init exited with errors (may be partial). Check logs."
fi

ok "Workspace ready"

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
upsert_env "CODEX_BYPASS_PERMISSIONS" "${CODEX_BYPASS_PERMISSIONS:-true}"
# Codex API credentials — persist to .env so the tmux session (which sources
# .env) and PM2 services (which read .env via ecosystem config) can find them
# on subsequent restarts without relying on Docker's environment re-injection.
upsert_env "OPENAI_API_KEY" "${OPENAI_API_KEY:-}"
upsert_env "CODEX_API_KEY" "${CODEX_API_KEY:-}"

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
  tmux kill-session -t codex-main 2>/dev/null || true
  pm2 kill 2>/dev/null || true
  # Kill the PM2 --no-daemon process directly in case pm2 kill didn't stop it
  [ -n "${PM2_PID:-}" ] && kill "${PM2_PID}" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Step 3: Start PM2 services ────────────────────────────────────────────────
step 3 "Starting services..."
pm2 start "${ZYLOS_DIR}/pm2/ecosystem.config.cjs" --no-daemon &
PM2_PID=$!

# Give PM2 a moment to spin up core services before starting Claude
sleep 3
ok "Services started"

# ── Step 4: Start the configured agent runtime in tmux ───────────────────────
# Determine runtime: ZYLOS_RUNTIME env var always wins; fall back to config.json.
if [ -z "${ZYLOS_RUNTIME:-}" ]; then
  ZYLOS_RUNTIME=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('${ZYLOS_DIR}/.zylos/config.json','utf8'));
      process.stdout.write(c.runtime || 'claude');
    } catch { process.stdout.write('claude'); }
  " 2>/dev/null || echo "claude")
fi

step 4 "Starting ${ZYLOS_RUNTIME} agent..."

if [ "${ZYLOS_RUNTIME}" = "codex" ]; then
  # Kill any stale Codex session
  tmux kill-session -t codex-main 2>/dev/null || true

  CODEX_ARGS=""
  if [ "${CODEX_BYPASS_PERMISSIONS:-true}" = "true" ]; then
    CODEX_ARGS="--dangerously-bypass-approvals-and-sandbox"
  fi

  tmux new-session -d -s codex-main -x 220 -y 50 \
    "cd ${ZYLOS_DIR} && source ${ENV_FILE} 2>/dev/null; exec codex ${CODEX_ARGS}"

  ok "Codex session started"
else
  # Kill any stale Claude session
  tmux kill-session -t claude-main 2>/dev/null || true

  CLAUDE_ARGS=""
  if [ "${CLAUDE_BYPASS_PERMISSIONS:-true}" = "true" ]; then
    CLAUDE_ARGS="--dangerously-skip-permissions"
  fi

  tmux new-session -d -s claude-main -x 220 -y 50 \
    "cd ${ZYLOS_DIR} && source ${ENV_FILE} 2>/dev/null; exec claude ${CLAUDE_ARGS}"

  ok "Claude Code session started"
fi

# ── All done ──────────────────────────────────────────────────────────────────
echo ""
info "=========================================="
ok "Zylos is ready!"
info "=========================================="
echo ""
info "Web console: http://localhost:3456"
info "Use 'docker exec <container> pm2 list' to check services."
info "Monitoring PM2..."
while kill -0 "${PM2_PID}" 2>/dev/null; do
  sleep 1
done
info "PM2 exited unexpectedly."
cleanup
