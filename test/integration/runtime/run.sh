#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE_NAME="${Z_RUNTIME_IMAGE:-zylos-runtime-test:local}"
REAL_IMAGE_NAME="${Z_RUNTIME_REAL_IMAGE:-zylos-runtime-test:real}"
SCENARIO_DIR="$SCRIPT_DIR/scenarios"
REAL_SCENARIO_DIR="$SCENARIO_DIR/real"
REAL_CLAUDE_AUTH_FILE="$SCRIPT_DIR/real-claude-auth.local.env"
# Codex authenticates from ~/.codex/auth.json (it ignores env vars), so its real
# credential is provisioned as a gitignored seed file the operator copies from
# their own ~/.codex/auth.json. Mounted into the container for real codex scenarios.
REAL_CODEX_AUTH_FILE="$SCRIPT_DIR/real-codex-auth.local.json"
# Claude Code authenticates from ~/.claude/.credentials.json (OAuth) or env vars.
# For real-smoke scenarios that run `claude -p` (not just `zylos runtime`), the
# OAuth credentials file must be mounted. Falls back to the operator's own file.
REAL_CLAUDE_CREDS_FILE="${REAL_CLAUDE_CREDS_FILE:-$HOME/.claude/.credentials.json}"
DEFAULT_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
FAKE_PATH="/runtime/bin:$DEFAULT_PATH"

usage() {
  cat <<'USAGE'
Usage:
  test/integration/runtime/run.sh <scenario|all|real-smoke>

Examples:
  test/integration/runtime/run.sh claude-success
  test/integration/runtime/run.sh all
  test/integration/runtime/run.sh real-smoke
USAGE
}

load_scenario() {
  local file="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue
    local key="${line%%=*}"
    local value="${line#*=}"
    printf -v "$key" '%s' "$value"
  done < "$file"
}

build_image() {
  local target="${1:-all}"
  local image="${2:-$IMAGE_NAME}"
  local install_real="${3:-0}"
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker CLI not found. Install/start Docker, then retry: $0 $target" >&2
    return 127
  fi
  docker build \
    -f "$SCRIPT_DIR/Dockerfile" \
    --build-arg "INSTALL_REAL_RUNTIMES=$install_real" \
    -t "$image" \
    "$REPO_ROOT"
}

has_claude_credentials() {
  if [[ -f "$REAL_CLAUDE_AUTH_FILE" ]]; then
    grep -Eq '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=.+' "$REAL_CLAUDE_AUTH_FILE"
    return $?
  fi

  # OAuth credentials file (for scenarios that run `claude -p` directly)
  [[ -f "$REAL_CLAUDE_CREDS_FILE" ]] && return 0

  [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]
}

has_codex_credentials() {
  # Codex reads ~/.codex/auth.json, so the only credential the harness can hand
  # to the container is the seed file the operator placed.
  [[ -f "$REAL_CODEX_AUTH_FILE" ]]
}

network_available() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -sS -I --connect-timeout 5 --max-time 8 https://api.anthropic.com >/dev/null 2>&1 &&
    curl -sS -I --connect-timeout 5 --max-time 8 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code' >/dev/null 2>&1
}

preflight_real_smoke() {
  # Gate the build on having at least one runtime's real credentials. Per-scenario
  # credential gating (see run_real_smoke) then skips individual scenarios whose
  # runtime lacks credentials, so a claude-only or codex-only operator still runs
  # the scenarios they can and skips (not fails) the rest.
  if ! has_claude_credentials && ! has_codex_credentials; then
    echo "SKIP real-smoke (no credentials / offline)"
    return 1
  fi
  if ! network_available; then
    echo "SKIP real-smoke (no credentials / offline)"
    return 1
  fi
  return 0
}

count_invocations() {
  local log_file="$1"
  if [[ ! -f "$log_file" ]]; then
    echo 0
    return
  fi
  grep -c '^binary=' "$log_file" || true
}

assert_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  [[ -z "$needle" ]] && return 0
  local normalized="$file"
  if [[ "$label" == "stdout" || "$label" == "stderr" ]]; then
    normalized="${file}.plain"
    sed -E $'s/\x1b\\[[0-9;]*m//g' "$file" > "$normalized" 2>/dev/null || cp "$file" "$normalized"
  fi
  if ! grep -Fq "$needle" "$normalized"; then
    echo "  expected $label to contain: $needle"
    echo "  actual $label:"
    sed 's/^/    /' "$normalized" || true
    return 1
  fi
}

run_one() {
  local scenario="$1"
  local scenario_file="${2:-$SCENARIO_DIR/$scenario.env}"
  local image="${3:-$IMAGE_NAME}"
  if [[ ! -f "$scenario_file" ]]; then
    echo "Unknown scenario: $scenario" >&2
    return 64
  fi

  local SCENARIO_CMD=""
  local SETUP=""
  local SETUP_RUNTIME=""
  local SCENARIO_ENV_FILE=""
  local EXPECT_EXIT=""
  local EXPECT_STDOUT=""
  local EXPECT_STDOUT_2=""
  local EXPECT_STDERR=""
  local EXPECT_INVOCATIONS=""
  local EXPECT_INVOCATION_CONTAINS=""
  local RUNTIME_MODE="fake"
  load_scenario "$scenario_file"

  if [[ -z "$SCENARIO_CMD" || -z "$EXPECT_EXIT" ]]; then
    echo "Scenario $scenario is missing required fields (need SCENARIO_CMD and EXPECT_EXIT)" >&2
    return 65
  fi

  local run_dir
  run_dir="$(mktemp -d "${TMPDIR:-/tmp}/zylos-runtime-${scenario}.XXXXXX")"
  local stdout_file="$run_dir/stdout.log"
  local stderr_file="$run_dir/stderr.log"
  local invocation_log="$run_dir/invocations.log"
  local docker_args=(
    --rm
    --env-file "$scenario_file"
    -e "HOME=/tmp/zylos-home"
    -e "ZYLOS_DIR=/tmp/zylos-home/zylos"
    -e "GOLDEN_DIR=/opt/zylos-golden"
    -e "FAKE_INVOCATION_LOG=/tmp/zylos-run/invocations.log"
    -v "$run_dir:/tmp/zylos-run"
  )

  case "${RUNTIME_MODE:-fake}" in
    real)
      docker_args+=(-e "PATH=$DEFAULT_PATH")
      # Use host networking so localhost-bound proxies (e.g. mihomo on
      # 127.0.0.1:7890) are reachable from inside the container.
      docker_args+=(--network host)
      # Forward host proxy settings so the in-container live probe reaches the
      # Anthropic API the same way the host does. The bare `-e NAME` form passes
      # the host value through when set and is a no-op when unset — so a host
      # behind a proxy (region-restricted egress) threads it into the container,
      # while a host whose IP can reach the API directly passes nothing and
      # connects directly. Both lower- and upper-case names are forwarded
      # because curl/Node honor different casings. This mirrors how the host-side
      # network_available() preflight already routes through the proxy.
      docker_args+=(
        -e HTTP_PROXY -e HTTPS_PROXY -e NO_PROXY
        -e http_proxy -e https_proxy -e no_proxy
      )
      if [[ -f "$REAL_CLAUDE_AUTH_FILE" ]]; then
        docker_args+=(--env-file "$REAL_CLAUDE_AUTH_FILE")
      else
        docker_args+=(
          -e ANTHROPIC_API_KEY
          -e CLAUDE_CODE_OAUTH_TOKEN
          -e ANTHROPIC_BASE_URL
          -e OPENAI_API_KEY
          -e CODEX_API_KEY
          -e OPENAI_BASE_URL
        )
      fi
      # Codex reads ~/.codex/auth.json, not env. When a codex auth seed is
      # provided, mount it so the container_script can stage it into HOME; the
      # genuine codex CLI then authenticates from it (apikey or chatgpt mode).
      if [[ -f "$REAL_CODEX_AUTH_FILE" ]]; then
        docker_args+=(-v "$REAL_CODEX_AUTH_FILE:/seed/codex-auth.json:ro")
      fi
      # Claude Code reads ~/.claude/.credentials.json for OAuth auth. Mount
      # the operator's credentials so `claude -p` scenarios can authenticate.
      if [[ -f "$REAL_CLAUDE_CREDS_FILE" ]]; then
        docker_args+=(-v "$REAL_CLAUDE_CREDS_FILE:/seed/claude-credentials.json:ro")
      fi
      ;;
    fake|"")
      docker_args+=(
        -e "PATH=$FAKE_PATH"
        -v "$SCRIPT_DIR:/runtime:ro"
      )
      ;;
    *)
      echo "Scenario $scenario has unknown RUNTIME_MODE: $RUNTIME_MODE" >&2
      return 65
      ;;
  esac

  # The container fixture builds the requested workspace state, then runs the
  # scenario command. SETUP selects how the workspace is prepared:
  #   minimal — empty workspace; SETUP_RUNTIME optionally seeds config.json
  #             (used to make a runtime switch a real switch, not a no-op).
  #   init    — clone the golden, build-time `zylos init` workspace baked into
  #             the image at $GOLDEN_DIR, giving a real post-init state.
  # ZYLOS_DIR is deliberately $HOME/zylos (see docker run below): generated
  # artifacts such as pm2/ecosystem.config.cjs resolve skill paths from
  # $HOME/zylos, NOT from $ZYLOS_DIR, so a post-init workspace is only usable
  # when this production invariant (ZYLOS_DIR == $HOME/zylos) holds.
  # SCENARIO_CMD is any command line (typically a `zylos ...` invocation).
  local container_script='
set -uo pipefail
mkdir -p "$HOME" "$ZYLOS_DIR/.zylos" "$ZYLOS_DIR/pm2"

# Stage the codex credential (mounted read-only at /seed) into HOME so the codex
# CLI, which only reads ~/.codex/auth.json, can authenticate. Copied (not used in
# place) because codex may rewrite the file when refreshing an OAuth token.
if [ -f /seed/codex-auth.json ]; then
  mkdir -p "$HOME/.codex"
  cp /seed/codex-auth.json "$HOME/.codex/auth.json"
fi

# Stage Claude Code OAuth credentials similarly. Claude reads
# ~/.claude/.credentials.json for OAuth-based auth (claude.ai subscription).
if [ -f /seed/claude-credentials.json ]; then
  mkdir -p "$HOME/.claude"
  cp /seed/claude-credentials.json "$HOME/.claude/.credentials.json"
fi

case "${SETUP:-minimal}" in
  init)
    if [ ! -d "$GOLDEN_DIR" ]; then
      echo "golden init workspace not found at $GOLDEN_DIR" >&2
      exit 70
    fi
    cp -a "$GOLDEN_DIR/." "$ZYLOS_DIR/"
    ;;
  minimal) ;;
  *)
    echo "unknown SETUP mode: $SETUP" >&2
    exit 70
    ;;
esac

if [ -n "${SETUP_RUNTIME:-}" ]; then
  printf "{\"runtime\":\"%s\"}\n" "$SETUP_RUNTIME" > "$ZYLOS_DIR/.zylos/config.json"
fi

if [ -n "${SCENARIO_ENV_FILE:-}" ]; then
  printf "%b\n" "$SCENARIO_ENV_FILE" > "$ZYLOS_DIR/.env"
elif [ "${SETUP:-minimal}" = minimal ] && [ ! -f "$ZYLOS_DIR/.env" ]; then
  : > "$ZYLOS_DIR/.env"
fi

eval "$SCENARIO_CMD"
'

  docker run "${docker_args[@]}" \
    "$image" \
    bash -c "$container_script" >"$stdout_file" 2>"$stderr_file"
  local exit_code=$?

  local failed=0
  if [[ "$exit_code" != "$EXPECT_EXIT" ]]; then
    echo "  expected exit $EXPECT_EXIT, got $exit_code"
    failed=1
  fi
  assert_contains "$stdout_file" "$EXPECT_STDOUT" stdout || failed=1
  assert_contains "$stdout_file" "$EXPECT_STDOUT_2" stdout || failed=1
  assert_contains "$stderr_file" "$EXPECT_STDERR" stderr || failed=1

  if [[ -n "$EXPECT_INVOCATIONS" ]]; then
    local actual_invocations
    actual_invocations="$(count_invocations "$invocation_log")"
    if [[ "$actual_invocations" != "$EXPECT_INVOCATIONS" ]]; then
      echo "  expected $EXPECT_INVOCATIONS fake invocations, got $actual_invocations"
      [[ -f "$invocation_log" ]] && sed 's/^/    /' "$invocation_log"
      failed=1
    fi
  fi
  if [[ -n "$EXPECT_INVOCATION_CONTAINS" ]]; then
    assert_contains "$invocation_log" "$EXPECT_INVOCATION_CONTAINS" "invocation log" || failed=1
  fi

  if [[ "$failed" == 0 ]]; then
    echo "PASS $scenario"
    rm -rf "$run_dir"
    return 0
  fi

  echo "FAIL $scenario"
  echo "  artifacts: $run_dir"
  return 1
}

run_real_smoke() {
  preflight_real_smoke || return 0
  build_image real-smoke "$REAL_IMAGE_NAME" 1 || return $?

  local scenarios=()
  local file
  while IFS= read -r file; do
    scenarios+=("$file")
  done < <(find "$REAL_SCENARIO_DIR" -maxdepth 1 -name '*.env' -type f | sort 2>/dev/null)

  if [[ "${#scenarios[@]}" == 0 ]]; then
    echo "No real-smoke scenarios found in $REAL_SCENARIO_DIR" >&2
    return 65
  fi

  local passed=0
  local failed=0
  local skipped=0
  for file in "${scenarios[@]}"; do
    local scenario requires
    scenario="$(basename "$file" .env)"
    # Per-scenario credential gating: a scenario declares which runtime's real
    # credentials it needs via REAL_REQUIRES (defaults to claude). When those
    # credentials are absent, skip — not fail — so an operator with only one
    # runtime's credentials still gets a green run for what they can test.
    requires="$(grep -E '^REAL_REQUIRES=' "$file" | head -1 | cut -d= -f2- || true)"
    case "${requires:-claude}" in
      codex)
        if ! has_codex_credentials; then
          echo "SKIP $scenario (no codex credentials)"
          skipped=$((skipped + 1)); continue
        fi
        ;;
      *)
        if ! has_claude_credentials; then
          echo "SKIP $scenario (no claude credentials)"
          skipped=$((skipped + 1)); continue
        fi
        ;;
    esac
    if run_one "$scenario" "$file" "$REAL_IMAGE_NAME"; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
    fi
  done

  echo
  echo "Real-smoke summary: $passed passed, $failed failed, $skipped skipped"
  [[ "$failed" == 0 ]]
}

main() {
  local target="${1:-}"
  if [[ -z "$target" || "$target" == "-h" || "$target" == "--help" ]]; then
    usage
    exit 64
  fi

  if [[ "$target" == "real-smoke" ]]; then
    run_real_smoke
    exit $?
  fi

  build_image "$target" "$IMAGE_NAME" 0 || exit $?

  if [[ "$target" != "all" ]]; then
    run_one "$target"
    exit $?
  fi

  local scenarios=()
  local file
  while IFS= read -r file; do
    scenarios+=("$(basename "$file" .env)")
  done < <(find "$SCENARIO_DIR" -maxdepth 1 -name '*.env' -type f | sort)

  local passed=0
  local failed=0
  local scenario
  for scenario in "${scenarios[@]}"; do
    if run_one "$scenario"; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
    fi
  done

  echo
  echo "Summary: $passed passed, $failed failed"
  [[ "$failed" == 0 ]]
}

main "$@"
