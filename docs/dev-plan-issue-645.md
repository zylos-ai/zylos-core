# Dev Plan: Reusable parameterized runtime integration-test image (#645)

## Summary
Build a reusable, version-controlled Docker harness that launches a **real zylos
runtime** and exercises auth-related behavior (`checkAuth` tristate, `--no-validate`,
base-URL injection) under different environment scenarios — without forking a
Dockerfile per scenario. The image is a stable, parameterized substrate; scenarios
are injected at run time as env/config.

> Revised after Jinglever R1 review: corrected `uncertain` gate semantics, added
> no-op avoidance + probe-invocation proof, split Claude/Codex cred sourcing, added
> base-URL assertion. Citations are to the reviewed runtime code.

## Scope

### In scope
- One version-controlled base-image Dockerfile (`zylos-runtime-test`) that installs
  zylos from local source and is **scenario-agnostic**. No secrets baked into any layer.
- A **deterministic probe stub via PATH shim**: fake `claude` / `codex` executables
  placed **on `PATH`** (named exactly `claude`/`codex`) whose exit code / stdout /
  stderr is driven by env vars, and which **record their own invocation** (args + env)
  to a file. PATH shim is required — not just `CLAUDE_BIN`/`CODEX_BIN` env overrides —
  because full `zylos runtime` runs `commandExists(target)` = `which <cmd>`
  (`cli/lib/shell-utils.js:13-16`) before probing. The shim lets every branch be
  reproduced in CI with no real credentials and no network, no production code change.
- A `run.sh <scenario>` harness: build base once (layer-cached) → run container with
  the scenario's env/mounts **and an isolated `HOME` + `ZYLOS_DIR`** → assert on
  `zylos runtime …` exit code, stdout/stderr matchers, **and the fake-invocation
  record** → pass/fail.
- A small set of **committed regression scenarios** (`scenarios/*.env` + fixtures),
  plus a CI workflow running them as a matrix.
- Docs: how to run ad-hoc (nothing committed) vs. how to add a permanent scenario.

### Out of scope
- Re-testing the tristate **classification logic** itself — already unit-locked by #640
  (Jest 111 + Node 523). This harness verifies the **end-to-end wiring** (env parsing
  from `.env`, `commandExists` preflight, process spawn, exit-code/stderr propagation,
  the switch gate) that unit tests stub out.
- **Codex `apikey` / base-URL branches** (`codex.js:186-200`) which need a mock HTTP
  endpoint — first deliverable covers Codex only via the `login status` branch
  (clean `HOME`, no `~/.codex/auth.json`). Mock-HTTP Codex scenarios → **follow-up**.
- Real-credential / real-network probing in CI. Real-cred runs are a documented
  **local-only ad-hoc** path, never committed, never in CI.
- The #644 probe-robustness changes — separate issue.

## Gate semantics (corrected — this drives every assertion)
The tristate has **two different consumers with different policies**:

| Consumer | `success` | `confirmed failure` | `uncertain` |
|----------|-----------|---------------------|-------------|
| **`zylos runtime` switch gate** (`runtime.js:205-217`) — fail-closed | proceed → exit 0 | refuse → **exit 2** | refuse, "inconclusive" → **exit 2** |
| **health-engine** (sites 4/5) — tolerant | recover | confirmed `auth_failed` | NOT treated as failure (no false restart) |

This harness tests the **switch gate**, so `uncertain` → **exit 2 + stderr match**
("authentication check was inconclusive" / reason), locked by
`cli/lib/__tests__/runtime-base-url.test.js:65-89`. `--no-validate` skips the probe
entirely → exit 0 regardless of stub outcome (`runtime.js:199-203`). The
"uncertain never causes a false failure" wording applies only to health-engine and
is **not** an assertion in this harness.

## Avoiding the already-on-target no-op (false-pass guard)
`switchRuntime()` returns early with "Already on `<target>` runtime." when
`current === target` and no save flags (`runtime.js:252-255`) — **before** any
install/save/probe (`:257+`, gate at `:298-301`). A scenario that hits this exits 0
without ever calling `checkAuth` → green CI, zero coverage. Therefore **every
scenario fixture must set the current runtime to the opposite of the target** (write
`.zylos/config.json` in an isolated `ZYLOS_DIR`), and **every non-`--no-validate`
scenario must assert the probe actually ran** (stdout `Checking <target>
authentication...` and/or the fake-invocation record). `--no-validate` asserts the
**reverse**: fake invocation count == 0.

## Development Checklist
- [ ] `test/integration/runtime/Dockerfile` — base image: node:22-slim + git/curl/bash,
      install zylos from local source (`npm i -g --install-links .`), no PM2 services,
      no secrets. Verify `zylos --version` in build.
- [ ] `test/integration/runtime/bin/claude` + `bin/codex` — env-driven PATH shims:
      honor `FAKE_<NAME>_EXIT` / `FAKE_<NAME>_STDOUT` / `FAKE_<NAME>_STDERR`, and
      append their argv + selected env (incl. `ANTHROPIC_BASE_URL`) to
      `$FAKE_INVOCATION_LOG`. Installed ahead of any real binary on PATH.
- [ ] `test/integration/runtime/run.sh <scenario>` — build (cache) → `docker run` with
      isolated `HOME`/`ZYLOS_DIR`, `--env-file scenarios/<scenario>.env`, fixture
      `.zylos/config.json` (current ≠ target) → capture exit + stdout/stderr +
      invocation log → assert → report.
- [ ] `test/integration/runtime/scenarios/` — committed regression scenarios:
      - `claude-success` → exit 0, probe invoked.
      - `claude-confirmed-failure` → exit 2, probe invoked.
      - `claude-uncertain` → **exit 2** + stderr "inconclusive", probe invoked.
      - `claude-no-validate` → exit 0, **probe NOT invoked** (count 0).
      - `claude-base-url` → fixture `.env` sets `ANTHROPIC_BASE_URL`; assert the shim's
        recorded probe env contains that base URL (verifies injection
        `claude.js:105-119`).
      - `codex-login-status-fail` → clean `HOME` (no `~/.codex/auth.json`) forces the
        `codex login status` branch (`codex.js:152-184`); stub it to fail → exit 2.
- [ ] `test/integration/runtime/README.md` — ad-hoc usage vs. adding a permanent
      scenario; note Codex apikey/base-URL is follow-up (needs mock HTTP).
- [ ] `.github/workflows/runtime-integration.yml` — trigger on `cli/**` +
      `test/integration/**`; buildx with layer cache; run scenarios as a matrix.
- [ ] `.dockerignore` review so the test image build context stays lean.

## Test Checklist
- [ ] `run.sh` passes for all committed scenarios locally.
- [ ] Re-running with no rebuild reuses the cached base image (substrate is stable).
- [ ] Adding a new scenario requires only a new `.env`/fixture + matrix row — no
      Dockerfile edit (demonstrate by adding a throwaway scenario in review, then removing).
- [ ] Each non-`--no-validate` scenario's invocation log proves the probe ran;
      `--no-validate` proves it did not.
- [ ] Scenarios are order-independent (isolated `HOME`/`ZYLOS_DIR`, no cross-pollution).
- [ ] CI workflow green on the branch.
- [ ] `grep` confirms no secret literals anywhere in the image build or committed files.

## Assumptions
- [ ] Adapter resolves `claude`/`codex` via `PATH` — **confirmed**: defaults are bare
      command names `CLAUDE_BIN`/`CODEX_BIN` (`claude.js:42`, `codex.js:46`) used via
      `execFileAsync` (`claude.js:130`, `codex.js:175`); preflight `commandExists` is
      `which` (`shell-utils.js:13-16`). ⇒ a PATH shim named `claude`/`codex` is required.
- [ ] `zylos runtime <name>` exit code reflects checkAuth **except** the
      already-on-target no-op — handled by the fixture guard above.
- [ ] **Claude** `checkAuth` reads creds from `ZYLOS_DIR/.env` (`claude.js:105-119`) —
      so Claude scenarios drive creds + base URL via the workspace `.env` fixture.
- [ ] **Codex** `checkAuth` does **NOT** read workspace `.env` (`codex.js:142-143`);
      it reads `~/.codex/auth.json`, else `codex login status` for chatgpt/missing
      (`codex.js:152-184`), HTTP probe only for `apikey` (`:186-200`). ⇒ Codex
      first-deliverable scenario uses a clean `HOME` to force the login-status branch;
      apikey/base-URL branches are follow-up.
- [ ] No production code change required — PATH shim + isolated `HOME`/`ZYLOS_DIR` is
      sufficient. If any seam turns out to be needed, flag before adding it.

## Acceptance Checklist (Howard accepts — no direct merge)
- [ ] Base image builds reproducibly; `grep` shows no secrets in any layer/file.
- [ ] Ad-hoc scenario runnable via runtime env injection (documented, demoed).
- [ ] All committed scenarios are **data** (`.env`/fixture) + matrix row, never a forked Dockerfile.
- [ ] Switch-gate semantics exact: success→0, confirmed-failure→2, **uncertain→2 +
      "inconclusive" stderr**, `--no-validate`→0 with probe skipped.
- [ ] Every non-`--no-validate` scenario proves the fake binary was invoked;
      `--no-validate` proves it was not.
- [ ] Scenarios isolate/reset `HOME` + `ZYLOS_DIR` + current runtime (order-independent).
- [ ] Claude base-URL scenario proves `ANTHROPIC_BASE_URL` reached the probe env.
- [ ] Codex scenario demonstrably hits the `login status` branch.
- [ ] CI workflow green; `npm test` still green; lint clean.
- [ ] Howard signs off before merge.
