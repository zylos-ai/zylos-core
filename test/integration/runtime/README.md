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
test/integration/runtime/run.sh real-smoke
```

`run.sh all` is the regression entry point. It builds `zylos-runtime-test:local`
with Docker layer cache, runs every committed scenario, and prints a pass/fail
summary. It covers the existing eight runtime/init scenarios plus the additive
`service-health` scenario, for 9 scenarios total.

`run.sh real-smoke` is an opt-in live check. Before any real image build, it
performs a host-side preflight for credentials and network access. If neither
runtime's credentials are present, or the host is offline, it prints
`SKIP real-smoke` and exits 0 without running `docker build`. When the preflight
passes, it builds a separate `zylos-runtime-test:real` image with the genuine
Claude/Codex CLIs and runs scenarios from `scenarios/real/`. It covers both
runtimes and both switch directions: `claude-real-auth-ok` (starts on codex,
switches to claude) and `codex-real-auth-ok` (starts on claude, switches to
codex).

Each real scenario declares the runtime whose credentials it needs via
`REAL_REQUIRES` (`claude` | `codex`, default `claude`). A scenario whose
credentials are absent is **skipped, not failed**, so an operator with only one
runtime's credentials still gets a green run for what they can test.

Real credentials are runtime-only — never commit secrets; both seed files are
git-ignored (`*.local.env`, `*.local.json`):

- **Claude** reads env-style credentials. Put `ANTHROPIC_API_KEY=` or
  `CLAUDE_CODE_OAUTH_TOKEN=` in `test/integration/runtime/real-claude-auth.local.env`,
  or export them in the host environment.
- **Codex** authenticates only from `~/.codex/auth.json` (it ignores env vars).
  Copy your live `~/.codex/auth.json` to
  `test/integration/runtime/real-codex-auth.local.json`; real mode mounts it and
  stages it into the container's `~/.codex/auth.json` (works for both `apikey`
  and `chatgpt` auth modes).

### Running real-smoke step by step

```bash
cd <repo root>

# 1. Claude credential (token or API key) — env-file form:
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$YOUR_TOKEN" \
  > test/integration/runtime/real-claude-auth.local.env
#    ...or export ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in your shell.

# 2. Codex credential — copy your live auth.json:
cp ~/.codex/auth.json test/integration/runtime/real-codex-auth.local.json

# 3. Ensure the container can reach the API. On a region-restricted host,
#    export the proxy (real mode forwards it into the container):
echo "$HTTPS_PROXY"   # should be set, e.g. http://host:7890

# 4. Run:
test/integration/runtime/run.sh real-smoke
#    → expect: PASS claude-real-auth-ok / PASS codex-real-auth-ok

# 5. Clean up the live credential seeds when done:
rm -f test/integration/runtime/real-claude-auth.local.env \
      test/integration/runtime/real-codex-auth.local.json
```

Provide only one runtime's credentials and the other scenario is skipped (still
exit 0). Provide neither and the whole run is skipped before any build.

The live probe inside the container must reach the API of the runtime under
test (Anthropic for claude; the codex `chatgpt` login-status check is local and
needs no network, while `apikey` mode probes the OpenAI API). Real mode forwards
the host's `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (both casings) into the
container, so a host behind a region-restricted egress proxy threads it through,
while a host whose IP reaches the API directly passes nothing and connects
directly. Note the host-side preflight only checks *reachability* (an HTTP
response), not authorization — `api.anthropic.com` answers an unauthenticated
probe with `403`, which counts as reachable. So on a host whose IP is
region-blocked **and** has no proxy configured, the preflight passes but the
in-container claude probe gets a real `403 Request not allowed` and that scenario
fails. Configure a proxy (or run from an IP that can reach the API) for
`real-smoke` to pass.

Preflight network check (conservative precondition): `network_available()`
currently uses the Anthropic API + the `@anthropic-ai/claude-code` npm registry
as its single network sentinel. The npm reachability check is what gates the
image build (both CLIs install from npm); the Anthropic check is claude-probe
oriented. Consequence: a host that can reach OpenAI/npm but not Anthropic would
`SKIP` the whole run at preflight even though the codex scenario alone could
pass. This is an accepted conservative gate for now; a future change could
relax it to "registry reachable + any required runtime's API reachable".

## How It Works

- The base image installs zylos from the local source tree.
- A scenario is a `.env` data file. It names the command to run
  (`SCENARIO_CMD`), how to prepare the workspace (`SETUP`), what to inject, and
  what to assert. Adding a scenario means adding a file — never editing the
  runner or forking the Dockerfile.
- Each scenario runs with an isolated `HOME`, and `ZYLOS_DIR` is set to
  `$HOME/zylos` — the same invariant production relies on. This matters for
  `SETUP=init`: generated artifacts such as `pm2/ecosystem.config.cjs` resolve
  skill paths from `$HOME/zylos`, not from `$ZYLOS_DIR`, so a cloned post-init
  workspace is only usable when the two coincide.
- Fake `claude` and `codex` binaries are mounted at runtime and placed first on
  `PATH`, so both `commandExists()` and adapter probes use the deterministic
  shims.

### Workspace Setup Modes (`SETUP`)

- `minimal` (default) — empty workspace. Optionally seed `SETUP_RUNTIME` to
  write `.zylos/config.json` (e.g. set the *current* runtime so a runtime switch
  is a real switch, not an already-on-target no-op).
- `init` — clone the **golden init workspace** baked into the image. At build
  time the Dockerfile runs `zylos init --yes --quiet` once (with
  `ZYLOS_DIR == $HOME/zylos`, the production invariant) into `/opt/zylos-golden`;
  `SETUP=init` clones that into the scenario's `ZYLOS_DIR` (which is `$HOME/zylos`).
  This gives a real post-init state (persisted config, deployed skills,
  templates) without re-running init per scenario. Fast (init runs once at
  build), real (genuine init output), isolated (each scenario gets its own
  copy). The build-time init runs offline via a throwaway `claude` stub that
  satisfies the auth probe; that stub lives at a build-only path and is absent
  from the runtime `PATH`, so it never shadows the mounted test shims. The build
  also gates golden-init health: it fails if init did not produce the expected
  ecosystem config and skill scripts (init swallows PM2/DB warnings and still
  exits 0, so the gate is what catches an incomplete bake).

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
RUNTIME_MODE=fake              # fake (default) | real
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

`RUNTIME_MODE=real` is only for scenarios under `scenarios/real/`, run through
`run.sh real-smoke`. In real mode the fake `/runtime/bin` shims are not mounted,
and credentials are injected from `real-claude-auth.local.env` or host environment at
container runtime.

Ad-hoc experiments can be run by adding a temporary scenario file locally. Keep
permanent regression scenarios as data/env fixtures; do not fork the Dockerfile
for a scenario.

## Scenarios

- `claude-*`, `codex-login-status-fail` — runtime auth fail-closed regression
  cases (minimal setup). These permanently guard the `zylos runtime` auth
  invariants.
- `post-init-runtime-status` — demonstrates `SETUP=init`: runs
  `zylos runtime status` against the golden post-init workspace and asserts it
  reports the runtime that init persisted (config-readable check).
- `post-init-ecosystem-paths` — stronger `SETUP=init` check: loads the generated
  `pm2/ecosystem.config.cjs` and asserts every service's script file exists in
  the cloned workspace, proving the post-init workspace is actually *usable*
  (skill paths resolve), not merely config-readable.
- `service-health` — uses `createRequire(<skill>/package.json)` for
  `scheduler`, `comm-bridge`, and `web-console`; asserts each
  `better-sqlite3` resolves from that skill's own nested
  `node_modules/better-sqlite3/`, then opens and writes a SQLite DB with that
  skill-scoped module. A hoisted/global `better-sqlite3` must not make this
  scenario pass.
- `real/claude-real-auth-ok` — opt-in live Claude auth smoke for
  `run.sh real-smoke`. It uses the real Claude CLI and runtime-injected
  credentials; no secret values belong in the scenario file.

## Scope Notes

Codex `apikey` and base-URL probing uses the HTTP branch and needs a mock HTTP
endpoint. This harness covers Codex through the deterministic
`codex login status` branch only.
