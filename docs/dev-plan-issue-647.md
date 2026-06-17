# Dev Plan: Higher-fidelity test harness — `RUNTIME_MODE=real` + service-health (#647)

## Summary
Extend the local integration harness (`test/integration/runtime/`) with two **opt-in, additive** higher-fidelity capabilities: (A) a real Claude/Codex API smoke mode that drives the *actual* runtime CLIs instead of the deterministic fakes, and (B) service-health assertions that prove native modules actually load (and optionally that the ecosystem starts) in the post-init golden workspace. The default offline/deterministic regression (`run.sh all`) stays byte-for-byte unchanged.

## Scope
**In scope**
- Part A — `run.sh real-smoke`: real CLI on PATH, runtime-only credential injection, liveness-level assertions, network/credential preflight that *skips* (not fails) when absent.
- Part B — an offline `service-health` scenario (in the default set) that `require()`s + opens a DB for the three DB-backed skills (scheduler / comm-bridge / web-console) inside the post-init golden workspace.

**Out of scope (explicit)**
- Any change to the default `run.sh all` semantics or its 8 existing scenarios (must stay green, offline, deterministic).
- Committing any real credential anywhere.
- Full multi-arch / multi-Node matrix.
- Live long-running service supervision (the `pm2 start` liveness check is a *stretch* item, see below — bounded only).

## Key design decisions (need Jinglever/Howard alignment before coding)

### D1 — Credential injection (HARD CONSTRAINT: never in git)
Support two runtime-only sources, in priority order:
1. A git-ignored creds file `test/integration/runtime/real-creds.local.env` (add `*.local.env` under this dir to `.gitignore`), loaded as a *second* `--env-file` only in real mode.
2. Host-env pass-through: if the creds file is absent, pass through `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL` (and codex equivalents) from the invoking shell via bare `-e VAR`.

Committed real-mode scenario `.env` files contain **only** `SCENARIO_CMD` / `EXPECT_*` / `RUNTIME_MODE=real` — never secrets.

### D2 — Real CLI availability in the image
Install the real CLIs behind a Docker build ARG, default OFF, so the standard image stays lean:
```dockerfile
ARG INSTALL_REAL_RUNTIMES=0
RUN if [ "$INSTALL_REAL_RUNTIMES" = "1" ]; then \
      npm install -g @anthropic-ai/claude-code <codex-pkg>; fi
```
`run.sh real-smoke` builds/uses an image built with `--build-arg INSTALL_REAL_RUNTIMES=1` (separate tag, e.g. `zylos-runtime-test:real`). Default `run.sh all` keeps building `zylos-runtime-test:local` with the ARG off — unchanged.

### D3 — Keeping real scenarios out of the default regression
Put real-mode scenarios in `scenarios/real/`. The existing `all` discovery uses `find … -maxdepth 1`, so a subdirectory is **already auto-excluded** — no change to `all` needed. `run.sh real-smoke` scans `scenarios/real/*.env`.

### D4 — PATH swap for real mode
Today PATH always prepends `/runtime/bin` (the fakes). In real mode, drop that prefix so the real CLI (installed at `/usr/local/bin` per D2) resolves. Implemented by branching the `-e PATH=…` and the `/runtime` mount on `RUNTIME_MODE`.

### D5 — Preflight + graceful skip
`real-smoke` must be a friendly no-op when prerequisites are missing: if no creds (D1) or no network, print `SKIP real-smoke (no credentials / offline)` and exit 0 — so it never breaks a normal contributor who runs it without secrets.

### D6 — Assertion granularity (real mode)
Reuse the existing `EXPECT_EXIT` / `EXPECT_STDOUT` machinery but assert only coarse liveness signals (exit 0, "authenticated", a session/handshake marker). No exact-output assertions (real responses are non-deterministic).

### D7 — Codex scope
Land Claude real-smoke first (clearest auth path). Add codex real-smoke in the same mode once the Claude path is proven; note its different auth (API key vs device/OAuth) in the scenario.

### D8 — `pm2 start` liveness (stretch, bounded)
Part B core = `require`+open-DB smoke (offline, deterministic, safe in default set). A live `pm2 start --no-daemon` check is fiddly in a one-shot container (foreground daemon). If included, it must be bounded: `pm2 start … && pm2 jlist`-assert online → `pm2 kill`, with a hard timeout. Default to *deferring* this unless cheap; the require/open-DB level already locks in the regression that #646 was about.

### D9 — Implementation & verification ownership
This is Docker-harness work whose only meaningful verification is `run.sh` against a real Docker engine. Jinglever's machine has **no Docker CLI**. Proposed: **zylos01 implements + verifies on the Docker-equipped server**; Jinglever reviews the dev plan and does code review; zylos0t does independent code review. (Adaptation of the standard "Jinglever develops" step, justified by the Docker-verification constraint. Flag to Howard.)

## Development Checklist
- [ ] D2: add `INSTALL_REAL_RUNTIMES` build ARG to `Dockerfile` (default 0, no-op for current builds).
- [ ] D1: `.gitignore` entry for `test/integration/runtime/*.local.env`; cred-file + host-env passthrough loader in `run.sh`.
- [ ] D4: branch PATH / `/runtime` mount on `RUNTIME_MODE` in the `docker run` invocation.
- [ ] D3: `run.sh real-smoke` subcommand scanning `scenarios/real/`; ensure `all` still scans only top-level (verify -maxdepth 1 behavior unchanged).
- [ ] D5: preflight (creds + network) → graceful `SKIP`/exit 0.
- [ ] Part A scenarios under `scenarios/real/`: `claude-real-auth-ok.env` (and a deliberately-bad-key negative if safe).
- [ ] Part B: `service-health.env` in the default set — node script that `require('better-sqlite3')` + open/CREATE/INSERT/SELECT/close a temp DB resolved from each of scheduler / comm-bridge / web-console under the golden workspace.
- [ ] D8 (stretch): bounded `pm2 start` liveness — only if clean.
- [ ] Update `test/integration/runtime/README.md` with the two modes + the no-secrets rule.

## Test Checklist
- [ ] `run.sh all` still = 8/8 + the new `service-health` scenario green (offline, no creds).
- [ ] `run.sh real-smoke` with NO creds → prints SKIP, exits 0 (D5).
- [ ] `run.sh real-smoke` with a real key (local only) → claude real scenario PASS at liveness level.
- [ ] Mutation check (reliability): break ecosystem generation → `service-health` FAILs; flip a real scenario's expectation → it FAILs. (Proves the new assertions actually discriminate.)
- [ ] Confirm no secret is present in any committed file (`git grep` for key prefixes; verify `.gitignore` covers the creds file).

## Assumptions
- [ ] `find -maxdepth 1` excludes `scenarios/real/` from `all` — **guaranteed** by current `main()` (line ~207); will assert in a test.
- [ ] `@anthropic-ai/claude-code` ships an installable CLI usable headless for an auth/liveness check — **needs validation** during D2/Part A.
- [ ] better-sqlite3 prebuilt for Node 22 installs cleanly in-image (already true post-#646) — **guaranteed** (verified at #646 merge).
- [ ] The golden workspace's `ecosystem.config.cjs` lists scheduler/comm-bridge/web-console with resolvable `script` paths — **guaranteed** by the build-time health gate (#646).

## Acceptance Checklist
- [ ] Part B `service-health` scenario added and green in default `run.sh all`; total = 9/9.
- [ ] Default regression unchanged otherwise (diff to existing scenarios = none).
- [ ] `run.sh real-smoke` no-creds path SKIPs cleanly; with-creds path verified locally (screenshot/log pasted to Howard, secret redacted).
- [ ] Mutation check demonstrated (broke something → red).
- [ ] No secrets committed; `.gitignore` verified.
- [ ] README documents both modes + no-secrets rule.
- [ ] Tests pass (`npm test`); harness `run.sh all` green on the Docker server.
