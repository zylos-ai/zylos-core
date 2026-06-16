# Runtime Integration Harness

This harness builds one reusable local Docker image and runs runtime auth
scenarios by injecting env/config at container start. It is intentionally
local-only: no GitHub Actions workflow is part of this deliverable.

## Run

Prerequisite: Docker CLI and a running Docker engine.

```bash
test/integration/runtime/run.sh all
test/integration/runtime/run.sh claude-success
```

`run.sh all` is the regression entry point. It builds `zylos-runtime-test:local`
with Docker layer cache, runs every committed scenario, and prints a pass/fail
summary.

## How It Works

- The base image installs zylos from the local source tree.
- Fake `claude` and `codex` binaries are mounted at runtime and placed first on
  `PATH`, so both `commandExists()` and adapter probes use the deterministic
  shims.
- Every scenario runs with an isolated `HOME` and `ZYLOS_DIR`.
- The fixture writes `.zylos/config.json` so the current runtime differs from
  the target runtime, avoiding the already-on-target no-op.
- Non-`--no-validate` scenarios assert that the fake binary was invoked.
  `claude-no-validate` asserts the probe was skipped.

## Add A Scenario

Add a new `.env` file under `test/integration/runtime/scenarios/`.

Required fields:

```text
SCENARIO_TARGET=claude
SCENARIO_CURRENT=codex
EXPECT_EXIT=0
```

Common fields:

```text
SCENARIO_ARGS=--no-validate
SCENARIO_ENV_FILE=ANTHROPIC_API_KEY=fake\nANTHROPIC_BASE_URL=https://example.test
FAKE_CLAUDE_EXIT=0
FAKE_CLAUDE_STDOUT=pong
FAKE_CLAUDE_STDERR=
EXPECT_STDOUT=Checking claude authentication...
EXPECT_STDERR=authentication check was inconclusive
EXPECT_INVOCATIONS=1
EXPECT_INVOCATION_CONTAINS=ANTHROPIC_BASE_URL=https://example.test
```

Ad-hoc experiments can be run by adding a temporary scenario file locally. Keep
permanent regression scenarios as data/env fixtures; do not fork the Dockerfile
for a scenario.

## Scope Notes

Codex `apikey` and base-URL probing uses the HTTP branch and needs a mock HTTP
endpoint. This first harness covers Codex through the deterministic
`codex login status` branch only.
