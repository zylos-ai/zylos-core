# Dev Plan: Reusable parameterized runtime integration-test image (#645)

## Summary
Build a reusable, version-controlled Docker harness that launches a **real zylos
runtime** and exercises auth-related behavior (`checkAuth` tristate, `--no-validate`,
base-URL injection) under different environment scenarios — without forking a
Dockerfile per scenario. The image is a stable, parameterized substrate; scenarios
are injected at run time as env/config.

## Scope

### In scope
- One version-controlled base-image Dockerfile (`zylos-runtime-test`) that installs
  zylos from local source and is **scenario-agnostic**. No secrets baked into any layer.
- A **deterministic probe stub**: a fake `claude` / `codex` binary placed on `PATH`
  whose exit code / stdout / stderr is driven by env vars. This lets every tristate
  branch (`success` / `uncertain` / `confirmed-failure`) be reproduced in CI with no
  real credentials and no network.
- A `run.sh <scenario>` harness: build base once (layer-cached) → run container with
  the scenario's env/mounts → assert on `zylos runtime …` output + exit code → pass/fail.
- A small set of **committed regression scenarios** (`scenarios/*.env`) covering the
  end-to-end wiring, plus a CI workflow running them as a matrix.
- Docs: how to run ad-hoc (nothing committed) vs. how to add a permanent scenario.

### Out of scope
- Re-testing the tristate **classification logic** itself — already unit-locked by #640
  (Jest 111 + Node 523). This harness verifies the **end-to-end wiring** (env parsing
  from `.env`, process spawn, exit-code propagation, `zylos runtime` command path) that
  unit tests stub out.
- Real-credential / real-network probing in CI (would require secrets). Real-cred runs
  are documented as a **local-only ad-hoc** path, never committed, never in CI.
- The #644 probe-robustness changes (pin model, reclassify unknown/non-zero) — separate issue.

## Key design decision (please validate, Jinglever)
`checkAuth` spawns the actual `claude` / `codex` CLI. To make integration scenarios
**deterministic, credential-free, and network-free**, the proposal is a **fake runtime
binary on PATH** controlled by env, e.g.:

```
FAKE_CLAUDE_EXIT=0           # process exit code the stub returns
FAKE_CLAUDE_STDOUT='...'     # scripted stdout (e.g. a successful probe reply)
FAKE_CLAUDE_STDERR='...'     # scripted stderr (e.g. an auth-error string)
```

A scenario then = a tiny `.env` that sets these (plus `ANTHROPIC_API_KEY` /
`ANTHROPIC_BASE_URL` / `--no-validate` as needed) and an expected (exit code, stdout
matcher). Open question for review: stub via PATH shim vs. a thin wrapper the adapter
already respects — pick the lowest-touch option that doesn't require production code changes.

## Development Checklist
- [ ] `test/integration/runtime/Dockerfile` — base image: node:22-slim + git/curl/bash,
      install zylos from local source (`npm i -g --install-links .`), no PM2 services,
      no secrets. Verify `zylos --version` in build.
- [ ] `test/integration/runtime/bin/fake-claude` + `bin/fake-codex` — env-driven stubs
      (exit/stdout/stderr); installed onto PATH ahead of any real binary in the image
      or via mount.
- [ ] `test/integration/runtime/run.sh <scenario>` — build (cache) → `docker run` with
      `--env-file scenarios/<scenario>.env` → capture exit+output → assert → report.
- [ ] `test/integration/runtime/scenarios/*.env` — committed regression scenarios:
      (a) confirmed success → switch proceeds, exit 0;
      (b) confirmed-failure → switch refused, non-zero exit;
      (c) uncertain → tolerated per #640 policy (no false failure);
      (d) `--no-validate` → probe skipped regardless of stub outcome.
- [ ] `test/integration/runtime/README.md` — ad-hoc usage vs. adding a permanent scenario.
- [ ] `.github/workflows/runtime-integration.yml` — trigger on `cli/**` +
      `test/integration/**`; buildx with layer cache; run scenarios as a matrix.
- [ ] `.dockerignore` review so the test image build context stays lean.

## Test Checklist
- [ ] `run.sh` passes for all four committed scenarios locally.
- [ ] Re-running with no rebuild reuses the cached base image (substrate is stable).
- [ ] Adding a new scenario requires only a new `.env` + matrix row — no Dockerfile edit
      (demonstrate by adding a throwaway 5th scenario in review, then removing it).
- [ ] CI workflow green on the branch.
- [ ] `grep` confirms no secret literals anywhere in the image build or committed files.

## Assumptions
- [ ] The runtime adapter resolves `claude`/`codex` via `PATH` (so a PATH shim
      intercepts it). **Needs validation** by reading `cli/lib/runtime/claude.js` /
      `codex.js` spawn calls — if it uses an absolute path, the stub strategy changes.
- [ ] `zylos runtime <name>` exit code reliably reflects the checkAuth outcome
      (refused switch → non-zero). Confirm against `cli/commands/runtime.js`.
- [ ] `checkAuth` reads creds from the workspace `.env`; the container must provide a
      minimal valid workspace layout for the command to run. Confirm minimal fixture.
- [ ] No production code change is required to make the runtime testable; if one is,
      flag it (small seam is acceptable, large refactor is a separate decision).

## Acceptance Checklist (Howard accepts — no direct merge)
- [ ] Base image builds reproducibly; `grep` shows no secrets in any layer/file.
- [ ] Ad-hoc scenario runnable via runtime env injection (documented, demoed).
- [ ] All committed scenarios are **data** (`.env`) + matrix row, never a forked Dockerfile.
- [ ] Four tristate/`--no-validate` scenarios pass; #640 safety invariant preserved
      (uncertain never causes a false failure).
- [ ] CI workflow green.
- [ ] `npm test` still green; lint clean.
- [ ] Howard signs off before merge.
