# Dev Plan: Migrate Codex runtime to native SessionStart hook (#652)

## Summary

Replace the Codex runtime's bespoke text-prompt bootstrap with Codex's **native
SessionStart hook**, pointed at the *same* `session-start-orchestrator.js` that
Claude already uses (from #651/PR #668). This gives both runtimes one bootstrap
model (memory inject + C4 session init + startup-prompt) and removes the
LLM-instruction-driven path that depends on the model obediently running scripts.

## Background / evidence (locked with Howard)

- **Feasible now.** Installed Codex is `0.142.0`; native hooks are GA and already
  live on this machine (dashboard telemetry uses them). No minimum-version gate —
  if a user's Codex is too old, they upgrade Codex.
- **The orchestrator is already runtime-neutral.** Its two context steps
  (`memory-inject`, `c4-session-init`) take **no arguments**; the *only* payload
  field it reads is `source`, used in exactly one functional spot:
  `if (source === 'compact') skip startup-prompt`. Everything else is labels.
  → The orchestrator file needs **no changes**.
- **`source` is non-critical for Codex (graceful degradation).** Empirically, the
  14 real Codex SessionStart payloads captured on this box (2026-06-20..23, in
  `dashboard.db`) had **no `source` field**: keys were
  `{hook_event_name, transcript_path, model, permission_mode}`. Current Codex docs
  (developers.openai.com/codex/hooks) say SessionStart *now* includes
  `source` ∈ `{startup, resume, clear, compact}` + `session_id`/`cwd` — a version
  addition. Either way the orchestrator is correct:
  - source present → used exactly like Claude (incl. `compact` skip);
  - source absent → never equals `compact` → full bootstrap runs every Codex
    SessionStart, which is exactly right (a Codex "new session" is always a fresh
    process). And we never reach native compaction anyway — Zylos rotates the
    session first.
- **Codex new-session = exit + reopen = fresh process**, so SessionStart always
  fires on a genuine start (given trust is established). **Reattach is not a
  concern** — an already-running session was bootstrapped when it started.

## Scope

**In scope**

1. Core registers a Codex `SessionStart` hook (content only) that runs
   `skills/activity-monitor/scripts/session-start-orchestrator.js`, appended into
   the shared `~/zylos/.codex/hooks.json` without disturbing other components' hooks.
2. **Core becomes the single trust authority**: at every Codex session start it
   re-establishes `trusted_hash` for *all* hooks in `hooks.json` (gated by a
   fingerprint so it's zero-cost when unchanged) and ensures `[features] hooks =
   true`. Components never manage trust. This heals any index shift / addition /
   removal from any component on one shared file — no separate files, no
   cross-component contract, no release ordering. (Decision rationale: "Cross-
   component coordination" section.)
3. Remove the bespoke bootstrap path in `cli/lib/runtime/codex.js` so memory
   inject + C4 init never run twice (single path = never-both-run by construction).
4. Hard smoke-test gate proving the hook fires in our interactive tmux
   (`--dangerously-bypass-approvals-and-sandbox`) mode before the old path is
   removed.

**Out of scope**

- No changes to `session-start-orchestrator.js` itself (already runtime-neutral).
- No minimum-version gating / capability detection / fallback path.
- No `hooks-active` runtime check (single path; not needed — agreed with Howard).
- Codex `PreCompact`/`PostCompact` handling (separate event; Zylos rotates before
  compaction). Not part of this issue.

## Key surfaces (verified in tree)

- `cli/lib/runtime/codex.js`
  - `buildCodexBootstrapPrompt()` (L73) — the text prompt to retire.
  - `CodexAdapter.launch()` (L276): injects the prompt in **both** paths —
    existing-session via `sendMessage` (L311–318) and new-session via
    `args.push(bootstrapPrompt)` (L332).
  - `enqueueStartupPrompt()` (L259) — currently a no-op ("prompt is the launch arg").
- `cli/lib/runtime-setup.js`
  - `writeCodexConfig(projectDir, opts)` (L427) writes `.codex/config.toml`
    (project + global) but **never** `hooks.json` — the natural place to also
    install/trust the orchestrator hook on install/upgrade/runtime-switch.
  - `renderCodexProjectConfig` (L361) / `renderCodexGlobalConfig` (L401).
- `cli/lib/sync-settings-hooks.js`
  - `CORE_MANAGED_HOOKS` (L34) already lists
    `skills/activity-monitor/scripts/session-start-orchestrator.js` (L40);
    `isCoreManaged()` (L48), `hookScriptKey()` from `hook-utils.js` — the Claude
    analog of what we add for Codex.
- Reference pattern (component, separate repo — replicate, don't import):
  dashboard `src/lib/hook-installer.js` → `installCodexHooks()` does a **scoped
  merge** (reads existing, finds its own group via `_isOwn`, upserts, preserves
  others) + `_trustCodexHooks()` drives `codex app-server` to set `trusted_hash`,
  + `_enableCodexHookFeature()` sets `[features] hooks = true`. **Confirmed merge,
  not overwrite** → dashboard needs no pre-fix; core just follows the same
  discipline and the two hooks coexist as separate groups in the same
  `SessionStart` array.

## Development Checklist

- [ ] **(A) Register core's hook CONTENT in shared `hooks.json`** (new module,
      e.g. `cli/lib/codex-hooks.js`), on the install/upgrade/`zylos runtime codex`
      path (wire via `writeCodexConfig` in `runtime-setup.js`):
  - [ ] Read existing `~/zylos/.codex/hooks.json` (tolerate missing/old formats).
  - [ ] **Append** a `SessionStart` group whose command runs the orchestrator
        (`node <SKILLS_DIR>/activity-monitor/scripts/session-start-orchestrator.js`),
        identified by an `_isOwn`-style match on the orchestrator path; **preserve
        all non-core groups** (esp. the dashboard telemetry hook). Idempotent upsert.
  - [ ] Set `timeout` in **seconds** (Codex unit) — ~25s (orchestrator budget ~17s).
        Do **not** copy Claude's `20000`.
  - [ ] Uninstall removes only core's own group.
  - [ ] **Set `[features] hooks = true` itself** in BOTH `~/.codex/config.toml`
        and `<projectDir>/.codex/config.toml`, idempotently. **Do not rely on the
        dashboard having set it** — on instances without the dashboard the flag is
        off and the hook would never fire. (Verified: present here only because the
        dashboard's `_enableCodexHookFeature` wrote both files.)
- [ ] **(B) Core = universal trust backstop at session start** (the decided
      design — see "Cross-component coordination" below). In `CodexAdapter.launch()`,
      **before** spawning codex:
  - [ ] Compute a fingerprint (content hash) of `~/zylos/.codex/hooks.json`; if
        unchanged since the last trust run (marker in core's data dir), **skip** —
        keep the common case zero-cost.
  - [ ] If changed (or first run): for **every** hook currently in `hooks.json`
        (core's + any component's), (re)establish a valid `trusted_hash` at its
        current `<file>:<event>:<groupIndex>:<hookIndex>` key via `codex app-server`
        (replicate dashboard's `_trustCodexHooks` flow), then persist the new
        fingerprint. This heals any index shift / new addition / staleness left by
        any component's merge or uninstall — components never manage trust.
  - [ ] Ensure `[features] hooks = true` here too (same backstop pass).
- [ ] **Remove the bespoke bootstrap path** in `cli/lib/runtime/codex.js`:
  - [ ] New-session: drop `args.push(bootstrapPrompt)` (L332).
  - [ ] Existing-session: drop the `sendMessage` prompt injection (L311–318) — the
        command still starts a fresh codex process → SessionStart fires → hook
        bootstraps.
  - [ ] Remove `buildCodexBootstrapPrompt()` (L73) if no longer referenced
        (dead-code removal), or keep only if something else uses it (verify).
  - [ ] Confirm `enqueueStartupPrompt()` (L259) behavior: the orchestrator's
        `session-start-prompt` step now enqueues the startup follow-up via
        scheduler/comm-bridge for Codex too. Verify this delivers to a Codex
        session (it's runtime-agnostic C4 delivery) and keep `enqueueStartupPrompt`
        a no-op (the hook owns startup now) — confirm no gap.
- [ ] **Template sync**: if Codex hook config has a template counterpart (mirror of
      `templates/.claude/settings.json`), add it so fresh installs converge.
- [ ] Update `CHANGELOG.md`.

## Test Checklist

- [ ] Unit: installer upserts core's SessionStart group and **preserves** a
      pre-existing dashboard-style group (no clobber); idempotent on re-run.
- [ ] Unit: installer migrates/ tolerates missing file + old flat-array format.
- [ ] Unit: feature flag set idempotently; uninstall removes only core's group.
- [ ] Unit: `codex.js launch()` no longer injects a bootstrap prompt in either
      path (new-session args contain no prompt; existing-session cmd has no `$_p`).
- [ ] Unit: trust backstop — when the `hooks.json` fingerprint changes, it
      re-establishes trust for ALL hooks at their current indices; when unchanged it
      skips (no app-server call). Mock the app-server boundary.
- [ ] Unit: backstop heals a simulated index shift (remove a leading group → a
      trailing hook's trust is re-keyed/re-hashed correctly on next run).
- [ ] Full suite green: `npm test` (Jest + Node).
- [ ] **Smoke test (HARD GATE — must pass before old path removal is final):**
      with real Codex `0.142.0` in interactive tmux bypass mode —
  - [ ] SessionStart hook actually fires (ref Codex issue #17532: project-level
        hooks "may not fire" unless trusted — our trust step must make it fire).
  - [ ] Orchestrator runs; memory context + C4 context are injected into the
        session (agent can answer an identity/memory question on first turn).
  - [ ] Capture the **current 0.142.0 SessionStart payload** from `dashboard.db`
        and record whether `source` is present (closes the version-drift question).
  - [ ] Confirm **no double-bootstrap** (memory-inject / c4-init run exactly once).
  - [ ] Confirm the startup follow-up prompt is delivered (Codex takes its first
        proactive action).

## Assumptions

- [ ] **Both core and dashboard write `~/zylos/.codex/hooks.json` with scoped
      merge.** Guaranteed for dashboard (verified `installCodexHooks` is upsert);
      core must implement the same discipline. Install order is then irrelevant.
- [ ] **A `SessionStart` event array can hold multiple hook groups** (core's +
      dashboard's), all firing. Implied by the nested format both already use;
      verify in smoke test.
- [ ] **The `[features] hooks` flag is NOT guaranteed on a fresh instance.**
      Needs validation/setting by core — it's only present here because the
      dashboard set it. Without it, no hook fires. (Core sets it; see checklist.)
- [ ] **Trust keys encode group/hook indices**
      (`<file>:<event>:<groupIndex>:<hookIndex>`), so index shifts would otherwise
      stale a sibling's trust. **Superseded by core's launch backstop** (item B):
      core re-establishes all trust at session start, so order/index changes self-
      heal. Append is still preferred to minimize churn, but is no longer a
      correctness requirement.
- [ ] **Codex injects multi-section plain-text stdout as context.** Docs say plain
      text is accepted; the orchestrator writes multiple `=== SECTION ===` blocks
      to stdout. Verify in smoke test.
- [ ] **Starting codex in an existing tmux session is a fresh process** (so
      SessionStart fires and reattach needs no separate bootstrap). Consistent with
      the launch flow; verify in smoke test.
- [ ] **Trust can be established non-interactively via `codex app-server`** the way
      the dashboard does. Guaranteed by dashboard's working implementation.

## Open questions for plan review (Jinglever / zylos0t)

1. **Trust code reuse.** Dashboard's trust logic lives in a separate component repo
   — core must have its own copy. OK to replicate `codex app-server` driving in
   `cli/lib/codex-hooks.js`, or is there a cleaner shared seam?
2. **Backstop cost/timing.** Is fingerprint-gated re-trust in `launch()` acceptable,
   and is driving `codex app-server` just before spawning interactive codex safe
   (sequential)? Confirm the cheapest correct "is trust already valid?" check.
3. **`enqueueStartupPrompt` for Codex.** Confirm the scheduler/comm-bridge startup
   prompt is the right mechanism for Codex's "first proactive action," vs. anything
   the old launch-arg prompt did that the orchestrator path doesn't cover.

## Cross-component coordination with dashboard (DECIDED)

**Design: core is the single trust authority; components declare hook content only.**
(Howard's call.) Components (dashboard, etc.) write their hook **content** into
`hooks.json` and never touch `trusted_hash`/`[features]`. Core, on every Codex
session start, re-establishes trust for **all** hooks present (see Dev Checklist
item B). This makes the shared `hooks.json` robust without any cross-component
contract or release ordering.

Supporting facts (verified on this box):
- **Content is already safe.** Dashboard's `_isOwn(command)` matches only its own
  `hook-ingest.cjs`; its install upserts only its own group, uninstall removes only
  its own group, and trust-removal touches only its own keys. Core's group is never
  clobbered or deleted by the dashboard.
- **Trust hash is content+context-sensitive and deterministic.** All 6 current
  hooks have byte-identical commands but 6 distinct `trusted_hash` values; the 4
  matcher-less ones differ only by event name → the hash incorporates at least the
  event (no random salt, else re-trust would never converge). So any index shift /
  addition needs trust re-established — which core's backstop does wholesale.

**Why this beats the alternatives we considered:**
- Beats "separate files (config.toml inline)": no need to verify whether Codex
  merges `config.toml`-inline + `hooks.json` hooks — we stay on the proven shared
  `hooks.json`.
- Beats "each component guards its own trust on uninstall": no per-component
  re-hash contract needed; core heals everything at launch.

**Trust model note (accepted trade-off):** core auto-trusting every hook in
`hooks.json` means "anything written there is allowed to run." Acceptable here —
the project dir is already `trust_level = trusted`; anyone able to write
`hooks.json` is already inside the trust boundary. The hash backstop is for
*functional consistency*, not a security boundary.

**Dashboard follow-up (optional, NOT a core-release blocker):** dashboard can drop
its own Codex trust-establishment code and let core own it. Idempotent with core in
the meantime (both set the same correct hash), so no ordering dependency — file as a
low-priority dashboard cleanup issue.

**Out of scope now (Howard):** if core is uninstalled, the dashboard has no reason
to exist (it depends on core) — so "core uninstall breaks dashboard trust" is a
non-scenario. The only live case is *dashboard uninstalled, core stays*, which
core's launch backstop already heals.

## Acceptance Checklist

- [ ] Codex session bootstraps via the native SessionStart hook (memory + C4
      injected) with the bespoke prompt fully removed.
- [ ] Dashboard's Codex telemetry hook still present and firing (no clobber).
- [ ] No double-execution of memory-inject / c4-session-init.
- [ ] Trust self-heals across a `hooks.json` change (simulate a component
      install/uninstall that shifts indices) — core's launch backstop re-trusts and
      the hook still fires.
- [ ] Dashboard uninstalled while core stays → core's hook still bootstraps (backstop
      re-trusts after the index shift).
- [ ] Smoke-test gate passed (all items above), with the captured 0.142.0 payload
      recorded in the PR.
- [ ] No regressions on the Claude path (orchestrator unchanged; Claude tests green).
- [ ] `npm test` green; lint clean.
