# Dev Plan: Upgrade-path auto-migration for instruction split (#729, P3)

## Summary

Make `zylos upgrade --self` automatically migrate A/B-class machines to the split-layer instruction architecture, and output a structured self-migration prompt for C-class machines so channel-only agents can resolve it without terminal access.

## Scope

**In:**
- Add `.zylos/instruction-format-version` protocol (the upgrade-path detection mechanism defined in Issue #729).
- Extract a shared migration engine (`executeMigrationApply`) from the CLI command — reused by both CLI and upgrade step 7, covering the full contract (conservation, backup+report+migrationMeta, activate, failure handling with report enrichment, A3 post-commit, version file write).
- Modify `step7_syncInstructions`: when `pendingMigration` detected and version file absent/stale, run auto-migration for A/B; write structured prompt for C.
- C-class consumer mechanism: session-start hook or instruction-builder check that surfaces the pending prompt to the agent's context.
- Complete failure/idempotency matrix with distinct handling for each failure phase.
- Tests for every path in the matrix.

**Out:**
- Changes to the migration tool's classification or conservation algorithms (P2 delivered).
- Fleet batch execution tooling (separate concern).
- Cross-process locking or reseed (#727).
- B-class provenance loader for machines that lack a prior marker (see Assumptions).

## Design

### 1. instruction-format-version protocol

New file: `.zylos/instruction-format-version` — a plain text file containing a single integer.

| File state | Meaning | Upgrade action |
|---|---|---|
| Missing | Pre-split installation (never migrated) | Attempt migration |
| `1` | Reserved (pre-split era marker, not currently written by any code) | Attempt migration |
| `2` | Split-layer active (current architecture) | Skip migration |
| `>2` | Future architecture version | Skip migration (forward-compatible) |
| Invalid/unreadable | Treat as missing | Attempt migration (with warning) |

**Write points:**
- `activateMigratedSplitInstructions` writes `2` after successful commit (inside the existing `commitEntries` transaction).
- `activateFreshSplitInstructions` writes `2` on the fresh-install path (new installs start at v2).
- The upgrade auto-migration path writes `2` after successful `executeMigrationApply`.

**Read point:**
- `step7_syncInstructions` reads the file before calling `refreshSplitInstructions`. If value is `2` or higher → skip migration entirely, proceed to refresh. If missing/`1`/invalid → run migration.

**Backfill:** Machines already migrated (meta.json marker exists, version file doesn't) get the version file written by `refreshSplitInstructions` on its next successful run — detected by `isSplitInstructionsActive() && !versionFileValid()`.

### 2. Shared migration engine

Extract `executeMigrationApply()` into `cli/lib/instruction-migration.js`. This is the core apply-path logic currently embedded in the CLI command, covering the full contract:

```
executeMigrationApply({ zylosDir, templatesDir, analysis, userContent, conservation,
                        faultInjector, backupFaultInjector, reportIo, settingsIo })
→ { migrated: bool, classification, backupPath, migrationMeta, a3, error,
    reportError, reportFallbackError, cleanupResidue }
```

**Contract (must match current CLI behavior exactly):**
1. Build `baseReport` (classification, matched, candidates, managedBlocks, userContent, originalSha256, attribution).
2. `createMigrationBackup` with rendered report — failure here → return `{ migrated: false, fatal: true }`.
3. `activateMigratedSplitInstructions` with full `migrationMeta` object (classification, matchedTemplate sha256+source, attributionBaseline, originalSha256, backupPath, migratedAt) — failure → `updateFailureReport` with fallback to `renderMigrationReport` if enrichment fails → return `{ migrated: false }` with backup preserved.
4. `reconcileAssemblerSettingsFile({ apply: true })` — failure → non-fatal (migration committed, hooks pending; exitCode 2 in CLI terms).
5. Write `instruction-format-version = 2` — failure → non-fatal (next upgrade re-detects but `isSplitInstructionsActive()` will catch it).

**CLI refactor:** The CLI command calls `executeMigrationApply` after its own classification/user-content/conservation steps (dry-run, --user-content, etc. stay in CLI).

### 3. step7_syncInstructions modification

New logic after the existing `refreshSplitInstructions` call:

```
read .zylos/instruction-format-version
  → value ≥ 2: skip migration, proceed with existing refresh result
  → missing/1/invalid:
    if result.pendingMigration:
      load catalog + classify
      if A or B:
        determine userContent (A: template ZYLOS.md, B: analysis.residual)
        verify conservation
        call executeMigrationApply(...)
        on success: return success message with classification + backupPath
        on failure: return PENDING MIGRATION fallback (upgrade must not fail)
      if C:
        write .zylos/pending-migration-prompt.md
        return message directing agent to read the prompt file
    else (not pending, but version file missing):
      backfill: write instruction-format-version = 2
```

### 4. B-class limitation

B-class classification requires provenance (`seedSha256` from an existing marker/meta.json). On a fresh upgrade of a machine that has never been migrated, there is no marker → no provenance → B cannot trigger. In practice:

- **A-class** (ZYLOS.md exactly matches a catalog baseline): will auto-migrate. This covers most fleet machines.
- **B-class** (template + identifiable user additions, proven by provenance): can only trigger if the machine somehow has a partial marker with `seedSha256`. In the upgrade auto-migration context, this is unlikely for un-migrated machines.
- **C-class** (everything else): gets the agent self-migration prompt.

This is acceptable for P3 scope. A future provenance loader (#727 scope or separate) could unlock B-class for more machines.

### 5. C-class prompt and consumer mechanism

**Prompt generation** (`writeMigrationPrompt`):
- File: `.zylos/pending-migration-prompt.md`
- Content: classification result, top-5 candidate baselines with similarity scores, original ZYLOS.md content hash, step-by-step agent instructions:
  1. Read your ZYLOS.md
  2. Identify system template content vs user-custom content (use the candidate baselines as reference)
  3. Extract user-custom content to a temp file
  4. Run `zylos migrate-instructions --apply --user-content <file>`

**Consumer mechanism:** The prompt file persists until migration succeeds. Detection:
- `refreshSplitInstructions` already returns `{ pendingMigration: true }` when the marker is missing.
- The step 7 message for C-class includes: `"instruction migration pending (class C) — self-migration prompt at .zylos/pending-migration-prompt.md"`.
- On subsequent session starts, the instruction builder sees `pendingMigration: true` and the agent's step 7 output (included in startup context) will reference the prompt file.
- Additionally: add a small check in `refreshSplitInstructions` that, when returning `pendingMigration: true` AND the prompt file exists, appends a note to the returned result: `migrationPromptPath: '<path>'`. The session-start hook can surface this to the agent.

**No separate session-start hook needed** — the existing `pendingMigration` signal + prompt file path is sufficient. The agent's ZYLOS.md/CLAUDE.md already gets the step 7 output at startup.

### 6. Prompt cleanup

After `refreshSplitInstructions` succeeds (returns `{ active: true }`) AND `instruction-format-version ≥ 2`:
- Delete `.zylos/pending-migration-prompt.md` if it exists (stale from a previous C-class detection).
- Wrap in try/catch — unlink failure is non-fatal (log warning, don't throw).

Timing: this runs in step 7 AFTER the refresh completes, not at step 7 entry. This ensures the prompt is only cleaned up when migration is confirmed complete.

### 7. Failure/idempotency matrix

| Phase | Failure point | Mutations so far | Recovery | Step 7 result |
|---|---|---|---|---|
| **Pre-mutation** | Catalog load, classify, conservation verify | None | Safe, nothing to undo | PENDING MIGRATION fallback |
| **Backup creation** | Disk write for backup dir | No live changes (backup is a new dir) | Safe | PENDING MIGRATION fallback |
| **Transaction** | `activateMigratedSplitInstructions` throws | Backup exists; live state may have transaction residue | Transaction residue preserved; next `refreshSplitInstructions` or `--apply` recovers | PENDING MIGRATION fallback; backup path + error in message |
| **Post-commit: A3** | `reconcileAssemblerSettingsFile` fails | Migration committed, hooks not converged | Non-fatal; agent can fix with `zylos migrate-instructions --apply` (re-runs A3 on already-active) | Step 7 "done" with warning; exitCode 0 (migration succeeded) |
| **Post-commit: version write** | `instruction-format-version` write fails | Migration committed, version file missing | Non-fatal; next upgrade re-detects, `isSplitInstructionsActive()` returns true → backfill writes the file | Step 7 "done" with warning |

**Idempotency:** Running step 7 on an already-migrated machine (version ≥ 2 OR `isSplitInstructionsActive()`) → skip migration entirely, proceed to refresh. Running step 7 twice on a fresh A-class machine → first run migrates and writes version 2; second run skips.

## Development Checklist

- [ ] Add `readInstructionFormatVersion({ zylosDir })` and `writeInstructionFormatVersion({ zylosDir, version })` helpers. Read returns `{ version: number | null, valid: boolean }`. Write is atomic (temp file + rename).
- [ ] Write version file in `activateMigratedSplitInstructions` and `activateFreshSplitInstructions` after successful commit.
- [ ] Add backfill logic in `refreshSplitInstructions`: if marker active but version file missing/stale, write version `2`.
- [ ] Extract `executeMigrationApply()` from the CLI command into `instruction-migration.js` — preserving the full contract (conservation result flow, backup with report, activation with migrationMeta, failure report enrichment, A3 reconciliation).
- [ ] Refactor CLI `migrateInstructionsCommand` to call `executeMigrationApply` (verify zero behavior change by running existing CLI tests).
- [ ] Add `writeMigrationPrompt({ zylosDir, analysis })` function that writes `.zylos/pending-migration-prompt.md`.
- [ ] Modify `refreshSplitInstructions` to include `migrationPromptPath` in the returned result when `pendingMigration: true` and prompt file exists.
- [ ] Modify `step7_syncInstructions`: read version file → decide migration path → A/B: call `executeMigrationApply` with try/catch fallback → C: call `writeMigrationPrompt` → cleanup stale prompt after successful refresh.
- [ ] Prompt cleanup in step 7: after refresh succeeds and version ≥ 2, delete stale prompt file (non-fatal).

## Test Checklist

- [ ] **Version file read/write:** round-trip, missing file → `null`, invalid content → `null`, atomic write doesn't corrupt on concurrent read.
- [ ] **Version file backfill:** `refreshSplitInstructions` on active marker without version file → version `2` written.
- [ ] **A-class auto-migration:** step 7 with ZYLOS.md matching a catalog baseline, no version file → full migration completed: backup exists with report, marker active, version `2` written, A3 reconciled, step 7 returns success message.
- [ ] **C-class prompt output:** step 7 with C-class ZYLOS.md → no migration, `.zylos/pending-migration-prompt.md` written (contains classification, candidates with scores, agent instructions), step 7 message references the prompt file path.
- [ ] **Already-migrated skip (version file):** step 7 with version `2` → no migration attempt, normal refresh.
- [ ] **Already-migrated skip (marker only, no version file):** step 7 with active marker but no version file → backfill version `2`, normal refresh, no migration attempt.
- [ ] **Pre-mutation failure fallback:** inject fault before backup → step 7 returns PENDING MIGRATION fallback, no live changes.
- [ ] **Transaction failure with recovery:** inject fault in `activateMigratedSplitInstructions` → backup preserved with enriched failure report, step 7 returns PENDING MIGRATION fallback, transaction residue present for next recovery.
- [ ] **Post-commit A3 failure:** inject fault in `reconcileAssemblerSettingsFile` → migration committed, step 7 returns success with warning, version file written.
- [ ] **Prompt cleanup:** step 7 with active marker + version ≥ 2 + stale prompt file → prompt file deleted.
- [ ] **Prompt cleanup failure (non-fatal):** inject unlink fault → step 7 still returns success, warning logged.
- [ ] **Idempotency:** run step 7 twice on A-class → first migrates, second skips cleanly.
- [ ] **CLI refactor regression:** existing `migrate-instructions` Jest tests pass unchanged after extracting `executeMigrationApply`.
- [ ] **Forward-compatibility:** step 7 with version `3` → skip migration (no downgrade attempt).

## Assumptions

- [ ] `refreshSplitInstructions` is called before auto-migration in step 7 — it deploys the system template files that the migration needs. Already the case in current code.
- [ ] `ctx.tempDir/templates` contains the new version's templates. Already the case.
- [ ] All migration functions (`loadInstructionCatalog`, `classifyInstructionBaseline`, `verifyInstructionConservation`, `createMigrationBackup`, `activateMigratedSplitInstructions`, `reconcileAssemblerSettingsFile`, `renderMigrationReport`, `updateFailureReport`) are stateless and accept `zylosDir`/`templatesDir` as parameters. Verified by reading their signatures.
- [ ] B-class auto-migration is limited to machines with existing provenance (seedSha256 in marker). Without a production provenance loader, most un-migrated machines will classify as either A or C. This is acceptable for P3 scope.
- [ ] C-class machines are a minority of the fleet (per P2 analysis: most machines are A-class with unmodified ZYLOS.md).

## Acceptance Checklist

- [ ] A-class fixture: full migration end-to-end — backup with report+migrationMeta, marker active, version `2`, A3 converged.
- [ ] C-class fixture: prompt file written with correct content, no migration, step 7 message references prompt path.
- [ ] Already-active machine (version ≥ 2): step 7 skips migration, normal refresh.
- [ ] Already-active machine (marker only): backfill version `2`, normal refresh.
- [ ] Pre-mutation fault injection: graceful fallback, upgrade not broken, no live changes.
- [ ] Transaction fault injection: backup preserved with failure report, PENDING MIGRATION fallback.
- [ ] Post-commit A3 fault: migration committed, warning but step 7 succeeds.
- [ ] Full Jest + Node regression green (including existing CLI tests after refactor).
- [ ] Real-machine test: on this box (already migrated), verify step 7 skips cleanly and backfills version file if missing.
