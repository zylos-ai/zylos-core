# Dev Plan: Unify runtime checkAuth into explicit tristate + add `--no-validate` (#640)

> Authoritative spec: issue #640 (body + two reconciled caller audits + the "Post-#641 reconciliation" comment). Baseline: `main` @ `48ac162` (#641 merged). This plan is the implementation contract; it does not re-open settled decisions.

## Summary

Refactor each runtime adapter's `checkAuth()` from `{ ok, reason }` into an explicit **tristate** `{ status: 'success' | 'failure' | 'uncertain', reason }`, push the "is uncertain acceptable?" decision out of the probe and into each of the 6 callers, make the `zylos runtime` switch gate strict (only `success` passes), add a standalone `--no-validate` flag that skips the switch-time probe, and fix the Claude probe to inject `ANTHROPIC_BASE_URL`.

The core hazard this addresses: today `uncertain` is silently folded into `ok: true`. That lets an unverifiable result pass the runtime-switch gate, and it is the right behavior for the health-engine (must tolerate transient blips) — but the two policies are currently tangled in the probe instead of being explicit per-caller.

## Scope

**In scope** (per issue #640 acceptance criteria):
1. `checkAuth()` → `{ status, reason }`, unified mapping across Claude + Codex; `ok` field removed.
2. All 6 call sites migrated to explicit per-status policy (table below).
3. Strict switch gate: only `status === 'success'` proceeds; `uncertain` and `failure` both `exit 2` (distinct messages).
4. Standalone `--no-validate` flag: skips the switch-time probe only; symmetric for both runtimes; **does not require `--save-*`**; preserves the already-on-target no-op early-return.
5. Claude `checkAuth()` injects `ANTHROPIC_BASE_URL` from `~/zylos/.env` (mirrors `launch()` at `claude.js:314`).
6. Codex login-status classifier becomes 3-way (success / failure / **uncertain**), reusing/extending `cli/lib/auth-parsers.js`.

**Out of scope** (explicitly deferred, do NOT implement here):
- Auto-rollback safety net for a `--no-validate` switch that lands on an unreachable runtime (separate issue/PR — touches health-engine).
- Removing auth validation from the default interactive switch or `zylos init`.
- The web-console frontend `checkAuth()` (`skills/web-console/public/app.js`) — namesake, unrelated.
- `isClaudeAuthenticated` / `isCodexAuthenticated` in `cli/lib/runtime-setup.js` — init helpers, no adapter `checkAuth()` call.

## Reconciled decision (issue body supersedes earlier audit note)

The pass-1 audit suggested constraining `--no-validate` to pair with `--save-apikey`/`--save-setup-token`. **The issue body/acceptance criteria override this:** `--no-validate` "works standalone, symmetric for both runtimes" and "does not require `--save-apikey`/`--save-setup-token` (orthogonal concern)." → **Bare `--no-validate` is allowed.** Rationale: it is an independent escape hatch for headless/prepare/mock/gateway contexts where the probe cannot succeed yet; the user is explicitly opting out of the safety check. Default (no flag) remains fail-closed.

## Tristate mapping (the contract)

| Bucket | Claude (`claude -p ping`) | Codex (apikey HTTP probe / `codex login status`) |
|---|---|---|
| **success** | exit 0, no "Not logged in" (`cli_probe`) | `/models` 200 (`http_probe_200`); login-status matches "Logged in" (`codex_login_status`) |
| **failure** | "Not logged in", `authentication_error`, unknown non-transient nonzero, no creds | `/models` 401; login-status explicitly "Not logged in"; apikey-mode-but-no-key |
| **uncertain** | `rate_limit_error`, `api_error`, `ETIMEDOUT`/`ECONNREFUSED`/`ENOTFOUND`, killed | `/models` 429/5xx/other-non-200; network error/timeout; login-status unparseable/empty/execFile threw |

**Codex login-status 3-way** (refinement enabled by #641): the current `parseCodexLoginStatus` returns a boolean. Add a sibling in `auth-parsers.js` (e.g. `classifyCodexLoginStatus(combined) → 'success' | 'failure' | 'uncertain'`): "Logged in" → success, "Not logged in" → failure, anything else / empty → uncertain. Keep the stdout+stderr combining (#641). The execFile `catch` (binary missing / killed) → **uncertain**, not failure.

## Per-caller policy (6 sites)

| # | File:line (`48ac162`) | New policy |
|---|---|---|
| 1 | `cli/commands/runtime.js:258` (switch gate) | `noValidate` → skip probe entirely. Else `success` → proceed; `failure` → exit 2 (auth-required copy); `uncertain` → exit 2 (distinct "auth check inconclusive — retry or `--no-validate`" copy) |
| 2 | `cli/commands/service.js:92` (status display) | `success` → authenticated; `failure` → NOT AUTHENTICATED; `uncertain` → "AUTH CHECK INCONCLUSIVE" / not-ready (no green pass, don't push user to swap key) |
| 3 | `cli/commands/doctor.js:297,302` (diagnostics) | `success` → ✓; `failure` → ✗ ("credential"); `uncertain` → unverified/inconclusive (not "credential wrong") |
| 4 | `skills/activity-monitor/scripts/health-engine.js:519` (set auth_failed) | only `status === 'failure'` sets `auth_failed`. `success`/`uncertain` → clear counters, no-op. **(safety invariant)** |
| 5 | `skills/activity-monitor/scripts/health-engine.js:575` (recovery probe) | only `status === 'success'` triggers `auth_recovered_restart`. `failure`/`uncertain` → STAY `auth_failed`, do NOT restart. **(highest-risk site — see invariant)** |
| 6 | `skills/activity-monitor/scripts/health-engine.js:662` (`_checkAuth` wrapper) | no-dep → `{ status:'success' }`; dep-throw → `{ status:'failure' }` (local probe broken). Plus shim `runtime-components.js:45` fallback → `{ status:'success', reason:'no_checkAuth' }` |

**Safety invariant (locked by tests):** the health-engine treats `uncertain` exactly like the old `{ok:true}` tolerance for the *set-auth_failed* path (sites 4) — only confirmed `failure` flips to `auth_failed`. But for the *recovery* path (site 5) the migration is the opposite of mechanical: old `uncertain={ok:true}` would have falsely triggered `auth_recovered_restart`; the new code must require `success` there. A network blip while in `auth_failed` must NOT restart the session.

## Development Checklist

- [ ] **base.js** — update `checkAuth()` JSDoc `@returns` to `{ status: 'success'|'failure'|'uncertain', reason }`; document `uncertain` = "cannot confirm; caller decides".
- [ ] **auth-parsers.js** — add `classifyCodexLoginStatus(combined)` 3-way classifier (keep existing `parseCodexLoginStatus` if still used elsewhere; otherwise migrate callers).
- [ ] **claude.js checkAuth** — map to tristate (success/failure/uncertain per table); **inject `ANTHROPIC_BASE_URL`** into probe env (read via `_parseEnvValue`, mirror `claude.js:314`).
- [ ] **codex.js checkAuth** — map apikey HTTP branch to tristate (200→success, 401→failure, 429/5xx/other→uncertain, network/timeout→uncertain); login-status branch uses `classifyCodexLoginStatus`; apikey-mode-but-no-key→failure; execFile catch→uncertain.
- [ ] **runtime.js** — `parseRuntimeFlags`: add `noValidate: flags.includes('--no-validate')`. Switch gate (`:258`): branch on `noValidate` then `auth.status`. Update `--help` text + usage comments to document `--no-validate`.
- [ ] **service.js:92** — 3-way display.
- [ ] **doctor.js:297,302** — 3-way display.
- [ ] **health-engine.js** — sites 519 / 575 / 662 per table; update JSDoc at `:59`.
- [ ] **runtime-components.js:45** — shim fallback → tristate.
- [ ] **Comments/docs** — accuracy touch-ups noted in audit ("only confirmed failure changes `auth_failed`"): `monitor.js`, `claude-probe.js`, `codex-probe.js`, `runtime.js:249`, `doctor.js:293`. Optional but preferred for correctness.

## Test Checklist

- [ ] `cli/lib/__tests__/codex.test.js` — migrate the **three** existing adapter `checkAuth()` tests from `{ ok }` → `{ status }` (apikey base-url; login-status "Not logged in"→failure; "Logged in"→success). Add: 401→failure; 429/5xx→uncertain; network error→uncertain; login-status unparseable→uncertain (use the existing `FAKE_CODEX_STATUS` harness).
- [ ] `cli/lib/__tests__/claude.test.js` (or equivalent) — success/failure/uncertain mapping; **assert `ANTHROPIC_BASE_URL` is injected** into the probe env.
- [ ] `cli/lib/__tests__/runtime-base-url.test.js` (or runtime flags test) — `--no-validate` is parsed; **bare `--no-validate` is accepted** (no `--save-*` required); switch gate skips probe when `noValidate`.
- [ ] `skills/activity-monitor/scripts/__tests__/health-engine.test.js` — migrate `{ok:true/false}` mocks → `{ status }`. **Add regression locks:** (a) set-auth_failed path: `uncertain` does NOT set `auth_failed`; (b) recovery path: in `auth_failed` + `uncertain` → stays `auth_failed`, `killTmuxSession` NOT called (count 0).
- [ ] Switch-gate tests: `uncertain` → exit 2; `failure` → exit 2; `success` → proceeds.
- [ ] Full suite green: `npm test` (node test runner 508+ ) **and** jest (111+). Run the complete CI locally before pushing.

## Assumptions

- [ ] **No external consumer of `{ ok }` remains.** Both reconciled audits (zylos01 pass-1 + zylos0t independent) found the 6-site consumer set complete; no `.ok` read survives outside them. → Guaranteed by audit; grep-verify `\.ok\b` against checkAuth results once more during impl.
- [ ] **`reason` strings are not asserted by any consumer** (only displayed/logged). → Verify; if a test/branch keys off a specific `reason`, preserve it.
- [ ] **`_parseEnvValue` + `.env` read pattern in `claude.js` checkAuth** can safely add `ANTHROPIC_BASE_URL` exactly as `launch()` does. → Guaranteed (same file, same helper).
- [ ] **Codex `auth.json` shape** (`auth_mode`, `OPENAI_API_KEY`/`apiKey`) unchanged. → Guaranteed by #641 baseline.
- [ ] **No-dep `_checkAuth` default of `success`** is correct: a monitor with no `checkAuth` dependency should not self-flag auth_failed. → Preserves prior `{ok:true}` semantics.

## Acceptance Checklist

- [ ] `checkAuth()` returns `{ status, reason }` for both adapters; no `ok` field anywhere.
- [ ] All 6 call sites migrated per the policy table; behavior changes limited to the intended ones (uncertain now blocks switch + shows "unverified" in status/doctor; health-engine unchanged in tolerance).
- [ ] Switch gate: `success` proceeds; `uncertain` and `failure` both exit 2 with distinct messages.
- [ ] `--no-validate`: skips the probe, works standalone, symmetric both runtimes; already-on-target no-op early-return still short-circuits before any work.
- [ ] Claude `checkAuth()` injects `ANTHROPIC_BASE_URL` (proxy/gateway probe hits the right endpoint).
- [ ] Health-engine invariant locked by tests: `uncertain` never sets `auth_failed`; `uncertain` never triggers recovery-restart.
- [ ] Full CI green locally (node + jest), lint clean. No regressions.
- [ ] Manual smoke: `zylos runtime <current> --no-validate` no-ops cleanly (already-on-target); `zylos service` / `zylos doctor` render the 3 states sensibly.

## Reviewers

- **Plan review:** Jinglever (focus: coverage of all 6 sites, the health-engine invariant tests, the standalone `--no-validate` decision).
- **Code review:** zylos0t (independent) + zylos01, focused on health-engine tristate semantics (site 5 is the highest-risk inversion).
