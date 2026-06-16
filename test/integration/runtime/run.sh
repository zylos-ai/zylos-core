#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE_NAME="${Z_RUNTIME_IMAGE:-zylos-runtime-test:local}"
SCENARIO_DIR="$SCRIPT_DIR/scenarios"

usage() {
  cat <<'USAGE'
Usage:
  test/integration/runtime/run.sh <scenario|all>

Examples:
  test/integration/runtime/run.sh claude-success
  test/integration/runtime/run.sh all
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
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker CLI not found. Install/start Docker, then retry: $0 ${1:-all}" >&2
    return 127
  fi
  docker build \
    -f "$SCRIPT_DIR/Dockerfile" \
    -t "$IMAGE_NAME" \
    "$REPO_ROOT"
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
  local scenario_file="$SCENARIO_DIR/$scenario.env"
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

  # The container fixture builds the requested workspace state, then runs the
  # scenario command. SETUP selects how the workspace is prepared:
  #   minimal — empty workspace; SETUP_RUNTIME optionally seeds config.json
  #             (used to make a runtime switch a real switch, not a no-op).
  #   init    — clone the golden, build-time `zylos init` workspace baked into
  #             the image at $GOLDEN_DIR, giving a real post-init state.
  # SCENARIO_CMD is any command line (typically a `zylos ...` invocation).
  local container_script='
set -uo pipefail
mkdir -p "$HOME" "$ZYLOS_DIR/.zylos" "$ZYLOS_DIR/pm2"

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

  docker run --rm \
    --env-file "$scenario_file" \
    -e "HOME=/tmp/zylos-home" \
    -e "ZYLOS_DIR=/tmp/zylos-data" \
    -e "GOLDEN_DIR=/opt/zylos-golden" \
    -e "FAKE_INVOCATION_LOG=/tmp/zylos-run/invocations.log" \
    -e "PATH=/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    -v "$SCRIPT_DIR:/runtime:ro" \
    -v "$run_dir:/tmp/zylos-run" \
    "$IMAGE_NAME" \
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

main() {
  local target="${1:-}"
  if [[ -z "$target" || "$target" == "-h" || "$target" == "--help" ]]; then
    usage
    exit 64
  fi

  build_image "$target" || exit $?

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
