# Local Integration Harness

This harness builds one reusable local Docker image and runs scenarios against
it by injecting workspace state, env, and config at container start. It is a
generic "run any `zylos` command in a controlled container and assert on the
result" runner — the runtime auth scenarios are its first consumer, not its only
purpose. It is intentionally local-only: no GitHub Actions workflow is part of
this deliverable.

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
- A scenario is a `.env` data file. It names the command to run
  (`SCENARIO_CMD`), how to prepare the workspace (`SETUP`), what to inject, and
  what to assert. Adding a scenario means adding a file — never editing the
  runner or forking the Dockerfile.
- Each scenario runs with an isolated `HOME` and `ZYLOS_DIR`, so scenarios never
  contaminate each other.
- Fake `claude` and `codex` binaries are mounted at runtime and placed first on
  `PATH`, so both `commandExists()` and adapter probes use the deterministic
  shims.

### Workspace Setup Modes (`SETUP`)

- `minimal` (default) — empty workspace. Optionally seed `SETUP_RUNTIME` to
  write `.zylos/config.json` (e.g. set the *current* runtime so a runtime switch
  is a real switch, not an already-on-target no-op).
- `init` — clone the **golden init workspace** baked into the image. At build
  time the Dockerfile runs `zylos init --yes --quiet` once into
  `/opt/zylos-golden`; `SETUP=init` clones that into the scenario's `ZYLOS_DIR`.
  This gives a real post-init state (persisted config, deployed skills,
  templates) without re-running init per scenario. Fast (init runs once at
  build), real (genuine init output), isolated (each scenario gets its own
  copy). The build-time init runs offline via a throwaway `claude` stub that
  satisfies the auth probe; that stub lives at a build-only path and is absent
  from the runtime `PATH`, so it never shadows the mounted test shims.

## Add A Scenario

Add a new `.env` file under `test/integration/runtime/scenarios/`.

Required fields:

```text
SCENARIO_CMD=zylos runtime claude
EXPECT_EXIT=0
```

Common fields:

```text
SETUP=minimal                  # minimal (default) | init
SETUP_RUNTIME=codex            # minimal mode: seed current runtime in config.json
SCENARIO_ENV_FILE=ANTHROPIC_API_KEY=fake\nANTHROPIC_BASE_URL=https://example.test
FAKE_CLAUDE_EXIT=0
FAKE_CLAUDE_STDOUT=pong
FAKE_CLAUDE_STDERR=
EXPECT_STDOUT=Checking claude authentication...
EXPECT_STDOUT_2=Switched to
EXPECT_STDERR=authentication check was inconclusive
EXPECT_INVOCATIONS=1
EXPECT_INVOCATION_CONTAINS=ANTHROPIC_BASE_URL=https://example.test
```

`SCENARIO_CMD` is run via `eval` inside the container, so it can be any command
line — `zylos runtime claude --no-validate`, `zylos runtime status`,
`zylos doctor`, etc. `EXPECT_INVOCATIONS` / `EXPECT_INVOCATION_CONTAINS` assert
against the fake-binary invocation log and are only meaningful for commands that
shell out to `claude`/`codex`.

Ad-hoc experiments can be run by adding a temporary scenario file locally. Keep
permanent regression scenarios as data/env fixtures; do not fork the Dockerfile
for a scenario.

## Scenarios

- `claude-*`, `codex-login-status-fail` — runtime auth fail-closed regression
  cases (minimal setup). These permanently guard the `zylos runtime` auth
  invariants.
- `post-init-runtime-status` — demonstrates `SETUP=init`: runs
  `zylos runtime status` against the golden post-init workspace and asserts it
  reports the runtime that init persisted.

## Scope Notes

Codex `apikey` and base-URL probing uses the HTTP branch and needs a mock HTTP
endpoint. This harness covers Codex through the deterministic
`codex login status` branch only.
