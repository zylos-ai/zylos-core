# Dev Plan: default model `opus[1m]` + new-session threshold coupled to model (#638)

## Summary
Change two shipped defaults: the default provisioned model becomes `opus[1m]` (latest Opus, 1M context), and the Claude new-session threshold default of `30` is introduced **coupled to the model** — `30` is written only when `opus[1m]` is also being set. Existing users whose model is not touched are never changed. This avoids the implicit-migration regression found during analysis (where flipping the runtime fallback would silently drop a class of existing v0.4+ users from 70% → 30%).

## Background / why this shape
Independent analysis (zylos01 + Jinglever) found:
- **Model** change is backfill-only on upgrade (`self-upgrade.js:501/982`, `sync-settings-hooks.js:33-47`) — existing users with a `model` set keep it. Safe.
- **Threshold**: the runtime reads `.zylos/config.json` `new_session_threshold`, falling back to `DEFAULT_THRESHOLD` only when the key is absent (`context-monitor.js:44-50`). The v0.4.11 migration that writes `70` lives in `runMigrations()`, which the normal v0.4+ self-upgrade path does **not** run (only the legacy `ZYLOS.md`-absent branch does — `self-upgrade.js:835`). So a class of existing users (have `ZYLOS.md`, never explicitly set the key — e.g. Howard's Mac Mini on v0.5.2) rely on the runtime fallback. Simply lowering `DEFAULT_THRESHOLD` to 30 would silently drop them 70 → 30, and would *not* even make fresh installs 30 (init seeds 70 before runtime reads). 

**Decision (Howard):** `30` is the default that pairs with the `opus[1m]` default model, not a global threshold change. Write `30` only when we set the model; never touch the threshold of a user whose model we don't touch. Runtime fallback stays `70`.

## Scope
**In scope:**
- Template default model → `opus[1m]` (DONE on this branch: `templates/.claude/settings.json`, test assertion, CHANGELOG model entry).
- Write `new_session_threshold = 30` to `.zylos/config.json` **only** when `opus[1m]` is set: (a) fresh install, (b) upgrade-time model backfill — and **only if the key is currently undefined**.
- Precise docs/CHANGELOG wording for the threshold behavior.
- Tests covering the full matrix.

**Out of scope:**
- Changing `DEFAULT_THRESHOLD` (stays `70`).
- Changing `codex_new_session_threshold` (stays `75`).
- Any migration that touches existing users whose model is not backfilled.
- Pinning `70` into existing users' config (explicitly rejected — when model isn't touched, write nothing).

## Behavior contract (the four boundaries — must hold exactly)
1. **Explicit value wins.** Only write `30` when `config.new_session_threshold === undefined`. Any existing legal value (70/50/anything) is preserved, even during a model backfill. `30` is a default baseline, never an override of user policy.
2. **Bind `30` to the model actually being written, not to eligibility.** Order within one sync flow: confirm installed settings have no `model` → write `model: opus[1m]` → settings persisted to disk → *then* write `new_session_threshold = 30` if undefined. Never pre-compute eligibility and write config before settings persist (avoids a crash window leaving `30` without `opus[1m]`).
3. **Fresh install vs re-init are separate.** Fresh install seeds `30`. Do **not** repurpose the shared missing-default helper (`ensureNewSessionThresholdDefaults()`, which writes `70`) to write `30` — that would hit re-init of existing installs. Re-init keeps its current behavior; it must not seed `30`.
4. **`DEFAULT_THRESHOLD` stays `70` and docs are precise.** No "Claude default threshold lowered to 30" global wording. Say: "fresh installs and upgrade-time model-backfill to `opus[1m]` write an explicit `new_session_threshold = 30`; the runtime fallback remains `70`."

## Development Checklist
- [x] `templates/.claude/settings.json` default model → `opus[1m]` (done on branch)
- [x] Update template-model assertion test → `opus[1m]` (done on branch)
- [ ] Fresh-install path: seed `new_session_threshold = 30` (only when undefined), distinct from the `70`-writing shared helper / migration; ensure it is not reachable from re-init
- [ ] Upgrade settings-sync path (normal v0.4+, the path that performs model backfill): after `opus[1m]` is written to `settings.json` successfully, write `new_session_threshold = 30` to `.zylos/config.json` iff undefined
- [ ] Confirm no path writes `30` when a `model` is already present, or when an explicit `new_session_threshold` exists
- [ ] CHANGELOG: precise threshold wording (per boundary #4)
- [ ] `skills/activity-monitor/SKILL.md`: keep fallback documented as `70`; document that fresh/opus[1m]-backfill installs get explicit `30`

## Test Checklist (matrix — all required)
- [ ] Fresh install → config has `new_session_threshold = 30` and `model = opus[1m]`
- [ ] Re-init of existing install (has model, no threshold key) → threshold **not** seeded to 30 (remains unwritten → runtime fallback 70)
- [ ] Upgrade, **no model + missing threshold** → after model backfill to `opus[1m]`, threshold written `30`
- [ ] Upgrade, **no model + explicit threshold** (e.g. 70 / 50) → model backfilled, threshold **preserved** (not overwritten)
- [ ] Upgrade, **has model** (with or without threshold) → threshold **not** written at all; model untouched
- [ ] Ordering guarantee: the `30` write occurs only after the `settings.json` model write persists (enforced by code structure and covered by a test)
- [ ] `DEFAULT_THRESHOLD === 70` (runtime fallback) assertion
- [ ] `npm test` (Jest + node) green

## Assumptions
- [ ] Runtime threshold resolution is solely `config.new_session_threshold` → else `DEFAULT_THRESHOLD` (verified `context-monitor.js:44-50`).
- [ ] The normal v0.4+ self-upgrade performs model backfill via the settings-sync step (`sync-settings-hooks.js`), and this is the correct place to also write the coupled `30` (Jinglever to confirm exact insertion point during implementation).
- [ ] `runMigrations()` (writes `70`) is not on the normal v0.4+ upgrade path (verified `self-upgrade.js:835`), so it will not clobber a fresh/backfill `30`.
- [ ] Fresh `zylos init` ordering allows seeding `30` such that the `70`-writing migration/helper sees the key present and no-ops (implementation must guarantee this ordering).

## Acceptance Checklist
- [ ] All matrix tests pass
- [ ] Manual: simulate the Mac-Mini case (has model, no threshold key) through an upgrade → config still has no `new_session_threshold`, runtime resolves 70 (no silent drop)
- [ ] Manual: fresh install → config has `new_session_threshold = 30`, model `opus[1m]`
- [ ] No regressions in existing tests
- [ ] CHANGELOG / SKILL.md wording matches boundary #4
- [ ] Independent code review (zylos0t) CLEAN
