# Dev Plan: Upgrade-path auto-migration for instruction split (#729, P3)

## Summary

Make `zylos upgrade --self` automatically migrate A/B-class machines to the split-layer instruction architecture, and output a structured self-migration prompt for C-class machines so channel-only agents can resolve it without terminal access.

## Scope

**In:**
- Modify `step7_syncInstructions` to auto-migrate when `pendingMigration` is detected.
- A/B class: programmatic call to `classifyInstructionBaseline` + `activateMigratedSplitInstructions` with full backup, zero user intervention.
- C class: write a structured migration prompt file (`.zylos/pending-migration-prompt.md`) containing classification, candidate baselines, similarity scores, and step-by-step agent instructions; step 7 message directs the agent to read it.
- Guard: read `isSplitInstructionsActive()` first — already-migrated machines skip entirely (idempotent).
- Tests for the upgrade-path trigger (A/B auto-success, C prompt output, already-migrated skip, migration failure fallback).

**Out:**
- Changes to the migration tool CLI itself (P2 delivered).
- Fleet batch execution tooling (separate concern).
- Cross-process locking or reseed (#727).

## Design

1. **Integration point**: `step7_syncInstructions` in `self-upgrade.js`, after `refreshSplitInstructions()` returns `{ pendingMigration: true }`. Currently this just emits a PENDING MIGRATION notice. New logic replaces that branch.

2. **Auto-migration flow (A/B)**:
   ```
   pendingMigration detected
   → load catalog (loadInstructionCatalog)
   → classify (classifyInstructionBaseline)
   → classification A or B:
     → createMigrationBackup (same safety as CLI)
     → activateMigratedSplitInstructions (same transaction as CLI)
     → reconcileAssemblerSettingsFile (A3 convergence)
     → step 7 message: "instruction migration completed automatically (class {A|B})"
   ```
   This reuses the exact same functions as the CLI `--apply` path — no new migration logic, only orchestration.

3. **C-class prompt output**:
   ```
   classification C:
   → write `.zylos/pending-migration-prompt.md` containing:
     - classification result and nearest candidate baselines with scores
     - the original ZYLOS.md content hash
     - step-by-step instructions for the agent:
       1. read your ZYLOS.md
       2. identify which parts are system template vs user-custom
       3. extract user-custom content to a temp file
       4. run `zylos migrate-instructions --apply --user-content <file>`
   → step 7 message: "instruction migration pending (class C) — agent self-migration prompt written to .zylos/pending-migration-prompt.md; the agent should process it on next session start"
   ```
   The prompt file persists until migration succeeds (marker becomes active), giving the agent multiple sessions to act.

4. **Failure fallback**: if auto-migration (A/B) throws during step 7, catch the error and fall back to the original PENDING MIGRATION notice — the upgrade itself must not fail because of a migration error. The backup created before the attempt is preserved for manual recovery.

5. **Cleanup**: after successful migration (A/B) or when `isSplitInstructionsActive()` returns true on a subsequent upgrade, delete `.zylos/pending-migration-prompt.md` if it exists (stale C-class prompt from a previous failed attempt or manual resolution).

6. **Idempotency**: `isSplitInstructionsActive()` is checked first. If the marker exists, step 7 skips migration entirely and proceeds to refresh (existing behavior). Re-running upgrade on an already-migrated machine is a no-op for migration.

## Development Checklist

- [ ] Extract the A/B auto-migration orchestration into a helper function `attemptAutoMigration({ zylosDir, templatesDir })` in `self-upgrade.js` (or a new `upgrade-migration.js` module) that: loads catalog, classifies, creates backup, activates, runs A3 — returns `{ migrated, classification, backupPath, error }`.
- [ ] Extract the C-class prompt generator into a function `writeMigrationPrompt({ zylosDir, analysis })` that writes `.zylos/pending-migration-prompt.md`.
- [ ] Modify `step7_syncInstructions`: when `pendingMigration` is true, call `attemptAutoMigration`; on A/B success return the auto-migrated message; on C write the prompt and return a C-class message; on error fall back to the PENDING MIGRATION notice.
- [ ] Add cleanup of stale `.zylos/pending-migration-prompt.md` when `isSplitInstructionsActive()` is true at step 7 entry.
- [ ] Ensure `templatesDir` is correctly sourced in step 7 (the new version's templates from `ctx.tempDir`, same as existing `refreshSplitInstructions` call).

## Test Checklist

- [ ] **A-class auto-migration**: step 7 with a pendingMigration fixture where ZYLOS.md matches a known baseline → migration completes, marker active, step 7 returns success message with classification A, backup exists.
- [ ] **C-class prompt output**: step 7 with a C-class ZYLOS.md → no migration, `.zylos/pending-migration-prompt.md` written with correct content (classification, candidates, agent instructions), step 7 message references the prompt file.
- [ ] **Already-migrated skip**: step 7 with active marker → no migration attempt, no prompt file written, normal refresh path.
- [ ] **Migration failure fallback**: inject a fault in `activateMigratedSplitInstructions` → step 7 catches error, returns PENDING MIGRATION fallback message (not a step 7 failure), backup preserved.
- [ ] **Prompt cleanup**: step 7 with active marker + stale `.zylos/pending-migration-prompt.md` → prompt file deleted.
- [ ] **Idempotency**: run step 7 twice on same A-class machine → first run migrates, second run skips (already active).
- [ ] **B-class auto-migration** (if provenance ledger exists): same as A-class test but with B classification fixture.

## Assumptions

- [ ] `refreshSplitInstructions` is called before auto-migration in step 7 — it deploys the system template files that the migration needs (assembler, system CLAUDE/AGENTS templates). This is already the case in the current code flow.
- [ ] The `templatesDir` from `ctx.tempDir` contains the new version's templates, which is the correct baseline for migration (same templates the CLI uses from `PACKAGE_ROOT`).
- [ ] Auto-migration in step 7 can reuse all the same functions as the CLI path (`loadInstructionCatalog`, `classifyInstructionBaseline`, `createMigrationBackup`, `activateMigratedSplitInstructions`, `reconcileAssemblerSettingsFile`) — they are stateless and accept `zylosDir`/`templatesDir` as parameters.
- [ ] C-class machines are a minority of the fleet (based on P2 analysis: most machines are A-class with unmodified ZYLOS.md).

## Acceptance Checklist

- [ ] A-class fixture: `step7_syncInstructions` auto-migrates, marker active, backup created, message confirms auto-migration.
- [ ] C-class fixture: prompt file written, no migration, message directs agent to the prompt.
- [ ] Already-active machine: step 7 skips migration, normal refresh.
- [ ] Fault injection: migration error → graceful fallback, upgrade not broken.
- [ ] Full Jest + Node regression green.
- [ ] Real-machine test: on this box (already migrated), verify step 7 skips cleanly.
