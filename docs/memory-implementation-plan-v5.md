# Memory Implementation Plan v5

Date: 2026-02-07  
Scope: Implement Memory Architecture v5 in `zylos-core` without writing runtime migration code in this phase.

## 0) Objective

Align the repository with `docs/memory-architecture-v5.md` by:

1. Replacing legacy memory layout (`context.md`, flat templates, `skills/memory`) with v5 tiered memory.
2. Introducing `skills/zylos-memory/` as the self-contained memory skill (`/zylos-memory`, `context: fork`).
3. Updating C4 trigger flow to remove per-message threshold checks (`c4-threshold-check.js`).
4. Updating templates, init deployment behavior, hooks, and scheduler task definitions.

---

## 1) Files To Create

### 1.1 New skill: `skills/zylos-memory/`

1. `skills/zylos-memory/SKILL.md`  
Purpose: Canonical memory workflow instructions for Claude skill invocation (`/zylos-memory`).  
Inputs: Hook output (`c4-session-init.js`), scheduler tasks, memory files under `~/zylos/memory/`.  
Outputs: Behavioral instructions for Claude; no direct program output file.  
Logic:  
- Frontmatter includes `name: zylos-memory`, `context: fork`, allowed tools.  
- Documents self-contained flow: rotate -> fetch unsummarized -> classify -> write memory -> checkpoint -> daily commit.

2. `skills/zylos-memory/package.json`  
Purpose: ESM module declaration for scripts in this skill.  
Inputs: None.  
Outputs: Node metadata.  
Logic: Minimal package metadata with `"type": "module"`.

3. `skills/zylos-memory/scripts/session-start-inject.js`  
Purpose: SessionStart hook injector.  
Inputs:  
- `~/zylos/memory/identity.md`
- `~/zylos/memory/state.md`
- `~/zylos/memory/references.md`
Outputs: Plain text to stdout (labeled sections).
Logic: Read existing files defensively, concatenate labeled sections, output gracefully on errors.

4. `skills/zylos-memory/scripts/rotate-session.js`  
Purpose: Daily session file rotation based on local TZ.  
Inputs: `~/zylos/.env` (`TZ`), `~/zylos/memory/sessions/current.md`.  
Outputs:  
- Moves old `current.md` to `YYYY-MM-DD.md` when date boundary crossed.  
- Creates fresh `current.md` header for current local day.  
Logic: Parse header date, compare with local date in configured TZ, rotate idempotently.

5. `skills/zylos-memory/scripts/memory-sync.js`  
Purpose: Self-contained C4 sync helper (fetch/checkpoint/status).  
Inputs:  
- C4 scripts in `~/zylos/.claude/skills/comm-bridge/scripts/`  
- `c4-db.js unsummarized` (current existing command)  
- `c4-fetch.js --begin --end`  
- `c4-checkpoint.js <endId> --summary`  
- Local state file `~/zylos/zylos-memory/last-fetch-range.json`  
Outputs:  
- Fetch output text (checkpoint summary + conversations)  
- Checkpoint command result text  
- Status JSON text  
Logic:  
- `fetch`: query unsummarized range internally, store range state, fetch conversations by range.  
- `checkpoint`: read saved range, write checkpoint using `end_id`, clear state file on success.  
- `status`: print unsummarized count/range.  
Note: Use existing C4 command `unsummarized`; do not depend on nonexistent `unsummarized-range`.

6. `skills/zylos-memory/scripts/daily-commit.js`  
Purpose: Local safety snapshot of `memory/` via git.  
Inputs: git repo at `~/zylos`, `memory/` changes, `TZ` from `.env`.  
Outputs: Optional commit `memory: daily snapshot YYYY-MM-DD`.  
Logic: No-op when no diff; stage `memory/`; commit; fail non-fatally.

7. `skills/zylos-memory/scripts/consolidate.js`  
Purpose: Weekly memory health report generator.  
Inputs: `~/zylos/memory/` files and directories.  
Outputs: JSON report to stdout (budgets, stale files, archive candidates, recommendations).  
Logic:  
- Size checks for core files (`identity.md`, `state.md`, `references.md`).  
- Session age scan (`sessions/*.md`).  
- Freshness classification for `reference/*`.  
- User profile size/mtime scan.

8. `skills/zylos-memory/scripts/memory-status.js`  
Purpose: Fast human-readable memory health summary.  
Inputs: `~/zylos/memory/` tree.  
Outputs: Text report with size, mtime, budget markers.  
Logic: Recursive scan, budget comparisons, total bytes and core budget percentages.

### 1.2 New template tree: `templates/memory/`

1. `templates/memory/identity.md`  
Purpose: bot identity + principles + digital asset references (no secrets).

2. `templates/memory/state.md`  
Purpose: active working state and pending/completed tasks.

3. `templates/memory/references.md`  
Purpose: pointer/index to config and paths; no duplicated `.env` values.

4. `templates/memory/users/default/profile.md`  
Purpose: default per-user profile scaffold.

5. `templates/memory/reference/decisions.md`  
Purpose: deliberate committed decisions.

6. `templates/memory/reference/projects.md`  
Purpose: project lifecycle tracking.

7. `templates/memory/reference/preferences.md`  
Purpose: shared team-wide preferences.

8. `templates/memory/reference/ideas.md`  
Purpose: uncommitted plans/explorations.

9. `templates/memory/sessions/.gitkeep`  
Purpose: ensure session directory exists in git.

10. `templates/memory/archive/.gitkeep`  
Purpose: ensure archive directory exists in git.

---

## 2) Files To Modify

1. `skills/comm-bridge/scripts/c4-session-init.js`  
Change: Replace action-required message to invoke `/zylos-memory` with no `--begin/--end` arguments.  
Reason: v5 self-contained sync; begin/end internalized.

2. `skills/comm-bridge/SKILL.md`  
Change: Remove per-message threshold-check language and script reference; document session-start trigger only + scheduled context-check path.

3. `skills/comm-bridge/references/hooks.md`  
Change: Update from two-hook model to SessionStart-only C4 hook usage for memory trigger; remove threshold-check section.

4. `templates/CLAUDE.md`  
Change: Replace old memory section (`context.md`, flat files) with v5 tiered model (`identity.md`, `state.md`, `references.md`, `users/`, `reference/`, `sessions/`, `archive/`) and `/zylos-memory` priority behavior.

5. `templates/.env.example`  
Change: Clarify TZ usage for memory scripts/scheduler.

6. `cli/commands/init.js`  
Changes required:  
- Update memory template deployment to support nested directories recursively (current implementation only copies top-level files).  
- Keep user-managed “only-if-missing” semantics for memory files.  
- Ensure nested folders (`users/default`, `reference`, `sessions`, `archive`) are created via copy process.  
- Add post-init task registration step (or explicit helper) for v5 scheduler tasks, idempotent by task name.

7. `skills/scheduler/SKILL.md` (optional but recommended)  
Change: Add canonical examples for v5 memory tasks (`context-check`, `session-rotation-daily`, `memory-daily-commit`, `memory-consolidation-weekly`) to reduce drift.

8. `README.md` (optional but recommended)  
Change: Reflect new memory structure and skill naming (`zylos-memory` replacing legacy `memory` guidance).

---

## 3) Files To Delete

1. `skills/comm-bridge/scripts/c4-threshold-check.js`  
Reason: removed by v5 architecture (no `UserPromptSubmit` threshold hook).

2. `skills/memory/SKILL.md`  
Reason: legacy placeholder skill superseded by `skills/zylos-memory/`.

3. `templates/memory/context.md`  
Reason: replaced by split `identity.md` + `state.md` + `references.md`.

4. `templates/memory/decisions.md`  
Reason: moved to `templates/memory/reference/decisions.md`.

5. `templates/memory/projects.md`  
Reason: moved to `templates/memory/reference/projects.md`.

6. `templates/memory/preferences.md`  
Reason: moved to `templates/memory/reference/preferences.md`.

Note: remove now-empty `skills/memory/` directory after deleting `skills/memory/SKILL.md`.

---

## 4) Implementation Order With Dependencies

### Phase A: Foundation
1. Create `skills/zylos-memory/package.json`.
2. Create `skills/zylos-memory/SKILL.md`.
3. Create all `skills/zylos-memory/scripts/*.js`.  
Dependencies: none (new tree).

### Phase B: C4 Trigger Alignment
4. Modify `skills/comm-bridge/scripts/c4-session-init.js` action-required output.
5. Delete `skills/comm-bridge/scripts/c4-threshold-check.js`.
6. Update `skills/comm-bridge/SKILL.md` and `skills/comm-bridge/references/hooks.md`.  
Dependencies: Phase A complete so trigger message points to existing skill.

### Phase C: Templates and Init Path
7. Replace `templates/memory/` with new v5 tree and files.
8. Update `templates/CLAUDE.md` memory section.
9. Update `templates/.env.example` (TZ context notes).
10. Modify `cli/commands/init.js` to recursively deploy `templates/memory/` and register scheduler tasks.  
Dependencies: template tree must exist before init logic is updated/tested.

### Phase D: Cleanup
11. Delete `skills/memory/SKILL.md` and remove empty `skills/memory/`.
12. Remove obsolete top-level memory template files.  
Dependencies: new skill and template replacements already in place.

### Phase E: Validation
13. Run lint/format/tests.
14. Execute end-to-end dry-run scenarios (fresh init, re-init, session-start output, scheduler task registration, memory-sync helper flow).

---

## 5) Template Files For `templates/memory/`

Required directory layout:

```text
templates/memory/
├── identity.md
├── state.md
├── references.md
├── users/
│   └── default/
│       └── profile.md
├── reference/
│   ├── decisions.md
│   ├── projects.md
│   ├── preferences.md
│   └── ideas.md
├── sessions/
│   └── .gitkeep
└── archive/
    └── .gitkeep
```

Template requirements:

1. `identity.md`: includes `Who I Am`, `Principles`, `Communication Style`, `Timezone`, `Digital Assets`; explicitly forbids secrets in file body.
2. `state.md`: includes `Last updated`, `Current Focus`, `Pending Tasks`, `Recent Completions`, lean/default-safe.
3. `references.md`: pointer-only structure to `.env`, registry/config files, key paths, services, IDs.
4. `users/default/profile.md`: identity, communication, preferences, notes, last updated.
5. `reference/*.md`: concise starter content with intended semantics and entry expectations.
6. `sessions/.gitkeep`, `archive/.gitkeep`: placeholders only.

---

## 6) `cli/commands/init.js` Changes For New Directory Structure

Current gap: `deployTemplates()` copies only first-level files from `templates/memory/`; nested folders required by v5 will not deploy.

Planned changes:

1. Replace top-level-only memory copy loop with recursive copy helper for memory templates.
2. Preserve existing policy: copy only missing destination files for user-managed files.
3. Ensure directory creation for nested paths before copy.
4. Keep PM2 ecosystem overwrite behavior unchanged.
5. Add `registerMemorySchedulerTasks()` after services start (fresh and complete install paths), with idempotent behavior:  
- Query existing tasks by name.  
- `add` if absent, `update` prompt/schedule/priority/idle if present.
6. Log task registration outcomes as non-fatal warnings on failure.

---

## 7) Hook Configuration Changes

Target runtime file: `~/.claude/settings.local.json` (user environment, not repo-tracked).

Required hook model:

1. Keep only `SessionStart` chain for memory triggering.
2. Order hooks:  
   1) `node ~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js`  
   2) `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js`
3. Remove `UserPromptSubmit` entry for `c4-threshold-check.js`.
4. Confirm `c4-session-init.js` output no longer references `/memory-sync --begin/--end`.

Documentation updates for hook behavior:

1. `skills/comm-bridge/SKILL.md`
2. `skills/comm-bridge/references/hooks.md`

---

## 8) Scheduler Task Definitions

Define four recurring tasks (via scheduler CLI), all with `--require-idle`.

1. `context-check`  
Timing: `--every "30 minutes"`  
Priority: `1`  
Prompt content (must be explicit): run check-context, parse %; `<70%` no action; `>=70%` invoke `/zylos-memory`; `>=85%` invoke restart after memory sync.

2. `session-rotation-daily`  
Timing: `--cron "0 0 * * *"`  
Priority: `2`  
Prompt: run `node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js`.

3. `memory-daily-commit`  
Timing: `--cron "0 23 * * *"`  
Priority: `3`  
Prompt: run `node ~/zylos/.claude/skills/zylos-memory/scripts/daily-commit.js`.

4. `memory-consolidation-weekly`  
Timing: `--cron "0 2 * * 0"`  
Priority: `2`  
Prompt: run `node ~/zylos/.claude/skills/zylos-memory/scripts/consolidate.js`, review report, archive/update as needed.

Idempotency strategy in init:

1. Find by `name`.
2. If present: `update <task-id>` with canonical values.
3. If absent: `add ... --name "<name>" ...`.

---

## 9) Testing Plan

### 9.1 Static/Unit
1. Validate all new scripts are ESM and executable (`node <script> --help` or default usage paths).
2. Lint pass for new/modified JS files.
3. Verify no stale imports/references to deleted `c4-threshold-check.js` or `skills/memory`.

### 9.2 Init and Template Deployment
1. Fresh init in clean test HOME:  
- `zylos init --yes`  
- Assert full nested memory tree exists under `~/zylos/memory/`.
2. Re-init:  
- Existing memory files unchanged.  
- Missing nested files created.
3. Verify `.env` includes preserved values plus new template defaults where applicable.

### 9.3 Hook Flow
1. Simulate SessionStart hook commands manually:  
- `session-start-inject.js` returns JSON with `additionalContext`.  
- `c4-session-init.js` output format includes `/zylos-memory` when threshold exceeded.
2. Confirm no per-message hook script remains in repo/runtime configuration.

### 9.4 C4/Memory Sync Integration
1. Seed conversations in C4 DB.
2. Run `memory-sync.js fetch`; verify:  
- uses internal unsummarized range detection,  
- persists fetch state file,  
- outputs expected C4 fetch text.
3. Run `memory-sync.js checkpoint --summary "..."`  
- checkpoint created with stored `end_id`,  
- state file removed.
4. Run `memory-sync.js status`; verify range/count output.

### 9.5 Scheduler
1. Register tasks and assert names/schedules/priorities via scheduler `list`/DB inspection.
2. For each task, run one manual execution pass and verify expected side effects:  
- rotation creates/rotates session logs by date,  
- daily commit no-ops without changes and commits with changes,  
- consolidation emits JSON report.

### 9.6 Regression Checks
1. `zylos init` still starts core services and initializes C4 DB.
2. Existing comm-bridge receive/send/dispatcher flows unaffected.
3. CLAUDE template generated in new install reflects v5 memory model.

### 9.7 Acceptance Criteria
1. Repository contains new `skills/zylos-memory/` and v5 template tree.
2. Legacy memory files/scripts removed.
3. C4 trigger language aligned to `/zylos-memory` no-arg invocation.
4. Init supports recursive memory template deployment.
5. Hook and scheduler definitions match v5 architecture.
