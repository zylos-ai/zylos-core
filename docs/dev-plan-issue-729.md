# Dev Plan: Upgrade-path auto-migration for instruction split (#729, P3)

## Summary

Make `zylos upgrade --self` automatically migrate A-class machines to the split-layer instruction architecture, and output a structured self-migration prompt for C-class machines so channel-only agents can resolve it without terminal access.

## Scope

**In:**
- Add `.zylos/instruction-format-version` protocol (the upgrade-path detection mechanism defined in Issue #729; write contract from P2 `docs/dev-plan-issue-722-p2.md:47`).
- Extract a shared migration engine (`executeMigrationApply`) from the CLI command — reused by both CLI and upgrade step 7, covering the full P2 contract.
- Modify `step7_syncInstructions`: singular executable sequence (read version → refresh/deploy/recovery → decide migration/backfill using refresh result + version state).
- A-class auto-migration in step 7.
- C-class: write structured prompt file + session-start shard to inject it into the agent's next session.
- Complete failure matrix aligned with P2 F1/F2 + residue two-phase semantics.
- Tests for every matrix path.

**Out:**
- B-class auto-migration (production B is an empty set — see Design §3).
- Changes to the migration tool's classification or conservation algorithms (P2 delivered).
- Step 7 warning delivery to channel-only callers (pre-existing limitation of the upgrade result reporting chain; not P3-specific — noted for a future issue).
- Fleet batch execution tooling (separate concern).
- Cross-process locking or reseed (#727).

## Design

### 1. instruction-format-version protocol

New file: `.zylos/instruction-format-version` — plain text, content `2\n` (no JSON, per P2 contract).

| File state | Meaning | Step 7 action |
|---|---|---|
| Missing | Pre-split installation (never migrated) | Attempt migration |
| `1` | Reserved (pre-split era marker, not written by current code) | Attempt migration |
| `2` | Split-layer active (current architecture) | Skip migration |
| `>2` | Future architecture version | Skip migration (forward-compatible) |
| Invalid/unreadable | Treat as missing | Attempt migration (with warning) |

**Single writer contract (per P2 `docs/dev-plan-issue-722-p2.md:47`):**

Ordering: marker commit (`commitEntries` rename, `instruction-builder.js:215-216`) → version write → A3.

The version file is written as a **separate atomic write** (temp + rename) immediately after `activateMigratedSplitInstructions` returns successfully, BEFORE `reconcileAssemblerSettingsFile`. It is NOT written inside `commitEntries` — it is a post-activation step.

Write points (each follows the same ordering contract):
- **Shared engine** (`executeMigrationApply`): writes after successful activation, before A3. This covers both the CLI `--apply` path and the upgrade step 7 auto-migration path.
- **`activateFreshSplitInstructions`**: writes after its `commitEntries` returns (fresh install path). This is a code addition to the existing function.

Version-write failure: non-fatal. Migration is success (marker is the source of truth). Emit stderr warning + remediation "rerun `--apply` to write the version file". Next upgrade reads version → missing → but `isSplitInstructionsActive()` is true → backfill.

**Backfill:** Step 7's decision matrix (Design §5) handles: marker active + version missing/stale → write version `2` (no migration attempt).

### 2. Shared migration engine

Extract `executeMigrationApply()` into `cli/lib/instruction-migration.js`. This function is the A/B/C apply path extracted from the CLI command (`cli/commands/migrate-instructions.js:212-302`), called by both CLI and upgrade step 7.

**Signature (every input sourced from its actual producer):**

```js
executeMigrationApply({
  zylosDir,            // path — caller provides
  templatesDir,        // path — caller provides (CLI: PACKAGE_ROOT/templates; step 7: ctx.tempDir/templates)
  original,            // string — raw ZYLOS.md content (caller reads fs)
  analysis,            // object — from classifyInstructionBaseline({original, catalog, provenance})
  userContent,         // string — caller determines: A → fs.readFileSync(templatesDir/ZYLOS.md); C → from --user-content file
  conservation,        // object — from verifyInstructionConservation({strippedContent, userContent, catalog, matched})
  faultInjector,       // function — for commitEntries fault injection
  backupFaultInjector, // function — for createMigrationBackup fault injection
  reportIo,            // object — for updateFailureReport I/O seam
  settingsIo,          // object — for reconcileAssemblerSettingsFile I/O seam
})
```

**Contract (step-by-step, matching current CLI `migrate-instructions.js:212-302`):**

1. Compute `originalSha256 = sha256(original)`.
2. Build `baseReport` from: `analysis.classification`, `conservation.matched` (NOT `analysis.matched` — conservation may refine the match), `analysis.candidates`, `analysis.managedBlocks`, `userContent`, `originalSha256`, `conservation.attributionBaseline`, `conservation.attribution`.
3. `createMigrationBackup({ zylosDir, report: renderMigrationReport({...baseReport, backupPath: '__BACKUP_PATH__'}), faultInjector: backupFaultInjector })` — failure → return `{ migrated: false, fatal: true, error }`. Zero live mutation (P2 F1: partial backup dir best-effort removed).
4. `activateMigratedSplitInstructions({ zylosDir, templatesDir, userContent, migrationMeta, faultInjector })` with `migrationMeta = { classification, matchedTemplate: conservation.matched ? {sha256, source: conservation.matched.sourceCommit} : null, attributionBaseline: conservation.attributionBaseline, originalSha256, backupPath: backup.backupPath, migratedAt }` — failure → `updateFailureReport(...)` with fallback to `renderMigrationReport(...)` if enrichment fails → return `{ migrated: false, fatal: true, backupPath, error, reportError?, reportFallbackError? }`. Backup + failure report preserved (P2 F2: durable evidence).
5. Write `.zylos/instruction-format-version` = `2\n` (atomic temp+rename) — failure → `{ versionWriteError }`, non-fatal.
6. `reconcileAssemblerSettingsFile({ zylosDir, apply: true, faultInjector, io: settingsIo })` — failure → non-fatal. Migration committed, A3 pending (P2 exit code 2 semantics).
7. Check `hasSplitTransactionResidue(zylosDir)` → `cleanupResidue`.

**Return type:**

```js
{
  migrated: boolean,         // true iff activation committed
  fatal: boolean,            // true on backup failure (zero live mutation)
  classification: string,
  backupPath: string | null,
  migrationMeta: object | null,
  a3: object | null,         // reconcileAssemblerSettingsFile result (null if not reached)
  a3Pending: boolean,        // true when migrated but A3 failed
  versionWritten: boolean,
  versionWriteError: Error | null,
  error: Error | null,       // primary failure (backup or transaction)
  reportError: Error | null,
  reportFallbackError: Error | null,
  cleanupResidue: boolean,
}
```

**CLI refactor:** The CLI command (`migrateInstructionsCommand`) calls `executeMigrationApply` after its own arg parsing, dry-run checks, classification, user-content determination, and conservation verification. The existing CLI test suite must pass unchanged.

### 3. Production B is an empty set — scope narrowed to A + C

The classifier requires `provenance.seedSha256` for B classification (`instruction-migration.js:120-146`). In the upgrade auto-migration context:
- Marker missing → `refreshSplitInstructions` returns `pendingMigration: true` — no marker → no provenance source.
- Marker present → already active, `refreshSplitInstructions` refreshes and skips classification entirely.

There is no reachable state where provenance exists but migration is pending. This matches the authoritative P2 statement (`docs/dev-plan-issue-722-p2.md:43,137`): "legacy 机不存在任何 seed provenance ledger → 自动 B 集合为空是预期结果, 不是缺陷".

**Decision:** P3 auto-migration handles A-class only. C-class gets the agent self-migration prompt. B-class auto-migration would require an external provenance source (out of P3 scope; file as a future consideration if needed).

The classifier still runs as-is and may return B if provenance is somehow provided in a future extension, but the upgrade step 7 code does not supply provenance and thus will never see B.

### 4. C-class prompt and consumer mechanism

**Prompt generation** (`writeMigrationPrompt`):
- File: `.zylos/pending-migration-prompt.md`
- Content: classification result, top-5 candidate baselines with similarity scores, original ZYLOS.md content hash, step-by-step agent instructions (read ZYLOS.md, identify system vs user content using candidates as reference, extract user content to temp file, run `zylos migrate-instructions --apply --user-content <file>`).

**Consumer mechanism — session-start shard (concrete, persisted, testable):**

Add a new core shard `migration-prompt` to the shard registry (`shard-registry.js`):
- Order: after `state` (order 4), before `c4-checkpoint` (order 5) — use order 4.5 or renumber.
- Emitter: checks if `.zylos/pending-migration-prompt.md` exists. If yes, reads and emits its content as a session-start message (wrapped in a `=== PENDING MIGRATION ===` header). If no, emits nothing (zero cost for already-migrated machines).
- This ensures the agent sees the migration prompt at every session start until migration completes.

**Step 7 message:** Step 7 returns a message referencing the prompt file path, but this message is NOT the consumer — it goes into the `steps` array which is not consumed by the C4 reply formatter (`cli/commands/component.js:124-170`) or the session-start injection chain. The shard is the authoritative consumer.

**Step 7 warning delivery (pre-existing limitation, not P3-specific):** A3 warnings and version-write warnings from step 7 are also not delivered to channel-only callers — the upgrade result `steps` array is not consumed downstream. This is a separate issue affecting all step messages, not specific to P3. Note for a future issue.

### 5. step7_syncInstructions — singular executable sequence

One sequence, no contradictions:

```
Step 7 entry:
  1. (existing) Deploy manifest template
  2. (existing) Legacy migration if ZYLOS.md missing
  3. Read instruction-format-version → versionState
  4. Run refreshSplitInstructions (ALWAYS — handles asset deploy, transaction recovery, refresh)
     → refreshResult: { active, pendingMigration }
  5. Decision matrix (versionState × refreshResult):

     ┌─────────────────────────┬────────────────────────┬──────────────────────────────────┐
     │                         │ refreshResult.active   │ refreshResult.pendingMigration   │
     ├─────────────────────────┼────────────────────────┼──────────────────────────────────┤
     │ version ≥ 2             │ (a) Normal refresh.    │ (d) Anomaly: version says        │
     │                         │ Clean up stale prompt. │ migrated but marker missing.     │
     │                         │ Done.                  │ Treat as needs-migration with    │
     │                         │                        │ warning.                         │
     ├─────────────────────────┼────────────────────────┼──────────────────────────────────┤
     │ version < 2 / missing / │ (b) Backfill: write    │ (c) Attempt auto-migration.      │
     │ invalid                 │ version = 2.           │ Classify → A: executeMigration   │
     │                         │ Clean up stale prompt. │ Apply → C: writeMigrationPrompt. │
     │                         │ Done.                  │                                  │
     └─────────────────────────┴────────────────────────┴──────────────────────────────────┘

  6. Case (c) / (d) migration:
     a. loadInstructionCatalog({ catalogPath: path.join(templatesDir, '..', 'data', 'instruction-baselines', 'manifest.json') })
        — note: catalogPath from the NEW version's package, not PACKAGE_ROOT
     b. Read original ZYLOS.md content
     c. classifyInstructionBaseline({ original, catalog }) — no provenance supplied
     d. If classification A:
        - userContent = fs.readFileSync(path.join(templatesDir, 'ZYLOS.md'), 'utf8')
        - conservation = verifyInstructionConservation({ strippedContent, userContent, catalog, matched: analysis.matched })
        - If !conservation.ok → PENDING MIGRATION fallback (conservation refusal)
        - try: executeMigrationApply({ ... }) → on success: return success message with classification + backupPath
        - catch: return PENDING MIGRATION fallback (upgrade must not fail because of migration)
     e. If classification C:
        - writeMigrationPrompt({ zylosDir, analysis })
        - return C-class message with prompt file path
  7. Clean up stale prompt file: cases (a) and (b) — active + version ≥ 2 → delete .zylos/pending-migration-prompt.md if exists. try/catch, non-fatal.
```

### 6. Failure matrix (aligned with P2 F1/F2 + residue two-phase semantics)

**Upgrade step 7 failure semantics:** step 7 catches all migration errors and returns PENDING MIGRATION fallback. The upgrade itself must never fail because of a migration error.

| Phase | Failure point | Mutations | Residue | Step 7 result |
|---|---|---|---|---|
| **Pre-mutation** | Catalog load, classify, conservation verify | None | None | PENDING MIGRATION fallback |
| **F1: Backup creation** | Disk write for backup dir fails | Zero live mutation | Partial backup dir best-effort removed (P2 F1) | PENDING MIGRATION fallback |
| **F2: Transaction** (clean rollback) | `activateMigratedSplitInstructions` throws, rollback succeeds | Live files restored to pre-mutation state | No `.split-txn.*` residue; durable backup + failure report preserved | PENDING MIGRATION fallback + backup path |
| **F2: Transaction** (rollback failure) | Rollback itself fails | Live files in indeterminate state | `.split-txn.*` recovery residue preserved (NOT cleaned — P2 two-phase: recovery residue is the record, next `--apply` recovers) | PENDING MIGRATION fallback + backup path |
| **Post-commit: version write** | Atomic write of version file fails | Migration committed, version file missing | None (marker is source of truth) | Step 7 "done" — migration succeeded; next upgrade re-detects via backfill (case b) |
| **Post-commit: A3** | `reconcileAssemblerSettingsFile` fails | Migration committed, hooks not converged | None | Step 7 "done" with a3Pending — migration succeeded; `zylos migrate-instructions --apply` converges A3 |
| **Post-commit: cleanup residue** | `commitEntries` cleanup of `.bak` files fails | Migration committed, committed `.bak` residue | `.split-txn.*.bak` files preserved | Step 7 "done" — next `--apply` recovery front-gate cleans them |

**Two-phase residue semantics (per P2 `docs/dev-plan-issue-722-p2.md:47`):** The fault-time assertion is that recovery residue IS preserved and identifiable (not "cleaned up"). The success-after-retry assertion is convergence to the clean terminal state (original files byte-for-byte preserved OR fully committed, no residue).

### 7. Helper signatures (verified from source)

| Function | File:Line | Signature |
|---|---|---|
| `loadInstructionCatalog` | `instruction-migration.js:25` | `({ catalogPath })` |
| `classifyInstructionBaseline` | `instruction-migration.js:120` | `({ original, catalog, provenance })` |
| `verifyInstructionConservation` | `instruction-migration.js:192` | `({ strippedContent, userContent, catalog, matched })` |
| `createMigrationBackup` | `instruction-migration.js:294` | `({ zylosDir, report, now?, faultInjector? })` |
| `renderMigrationReport` | `instruction-migration.js:245` | `({ classification, matched, candidates, managedBlocks, userContent, originalSha256, attributionBaseline?, attribution?, backupPath, failure? })` |
| `updateFailureReport` | `instruction-migration.js:477` | `({ backupPath, baseReport, failure, io? })` |
| `activateMigratedSplitInstructions` | `instruction-builder.js:306` | `({ zylosDir, templatesDir, assemblerSource?, userContent, migrationMeta, faultInjector?, now? })` |
| `reconcileAssemblerSettingsFile` | `instruction-migration.js:439` | `({ zylosDir, apply, faultInjector?, io? })` |
| `sha256` | `instruction-migration.js:21` | `(content)` → hex string |
| `hasSplitTransactionResidue` | `instruction-builder.js` | `(zylosDir)` → boolean |

The shared engine calls each function with its actual signature. `zylosDir`/`templatesDir` are threaded as needed, but not all functions accept them — the engine assembles intermediate values (catalog, original content, analysis, baseReport) and passes them to each function per its own interface.

## Development Checklist

- [ ] Add `readInstructionFormatVersion({ zylosDir })` → `{ version: number | null, valid: boolean }` and `writeInstructionFormatVersion({ zylosDir, version })` (atomic temp+rename) helpers.
- [ ] Write version file in `activateFreshSplitInstructions` after `commitEntries` returns (fresh install path).
- [ ] Extract `executeMigrationApply()` from CLI command into `instruction-migration.js` with the exact signature, contract, and return type defined in Design §2.
- [ ] Refactor CLI `migrateInstructionsCommand` to call `executeMigrationApply` — verify zero behavior change via existing CLI test suite.
- [ ] Add `writeMigrationPrompt({ zylosDir, analysis })` function.
- [ ] Add `migration-prompt` core shard to `shard-registry.js` (Design §4): checks for `.zylos/pending-migration-prompt.md`, emits content if present, emits nothing if absent.
- [ ] Add shard emitter script for `migration-prompt`.
- [ ] Modify `step7_syncInstructions` per Design §5: read version → refresh → decision matrix → migration/backfill/cleanup.
- [ ] Prompt cleanup in step 7 cases (a)/(b): delete stale prompt file, non-fatal.
- [ ] Backfill in step 7 case (b): write version = 2 for marker-active + version-missing machines.

## Test Checklist

- [ ] **Version file helpers:** round-trip read/write, missing file → `null`, invalid content → `{ version: null, valid: false }`, atomic write (verify no corruption on concurrent read).
- [ ] **Version file in fresh install:** `activateFreshSplitInstructions` → version file contains `2`.
- [ ] **CLI refactor regression:** all existing `migrate-instructions` Jest tests pass unchanged after extracting `executeMigrationApply`.
- [ ] **A-class auto-migration (step 7 case c, classification A):** ZYLOS.md matches a catalog baseline, no version file → full migration: backup exists with report+migrationMeta (using `conservation.matched`), marker active, version `2` written, A3 reconciled, step 7 returns success.
- [ ] **C-class prompt output (step 7 case c, classification C):** C-class ZYLOS.md → no migration, `.zylos/pending-migration-prompt.md` written (classification, candidates with scores, agent instructions), step 7 message references prompt path.
- [ ] **C-class shard consumer:** pending-migration-prompt.md exists → shard emits content in session-start injection. File absent → shard emits nothing.
- [ ] **Already-migrated skip — version file (case a):** version `2` + active marker → no migration attempt, normal refresh.
- [ ] **Backfill (case b):** active marker + version file missing → version `2` written, normal refresh.
- [ ] **Forward-compatibility (case a):** version `3` → skip migration.
- [ ] **Anomaly (case d):** version `2` + pendingMigration → migration attempted with warning.
- [ ] **Pre-mutation failure:** inject fault before backup → step 7 returns PENDING MIGRATION fallback, zero live changes.
- [ ] **F1: Backup creation failure:** inject fault in `createMigrationBackup` → `{ fatal: true }`, zero live mutation, partial backup best-effort removed.
- [ ] **F2: Transaction failure, clean rollback:** inject fault in `activateMigratedSplitInstructions` at a stage/rename point that allows rollback → live files restored, no `.split-txn.*` residue, durable backup + failure report preserved, step 7 returns PENDING MIGRATION fallback.
- [ ] **F2: Transaction failure, rollback failure:** inject fault in rollback path → `.split-txn.*` residue preserved (NOT cleaned), durable backup preserved, step 7 PENDING MIGRATION fallback. **Retry convergence:** subsequent `--apply` → recovery front-gate cleans residue → migration succeeds.
- [ ] **Post-commit: cleanup residue:** inject cleanup failure after commit → committed `.bak` residue preserved, migration success, version written. **Retry convergence:** subsequent `--apply` → recovery cleans `.bak`.
- [ ] **Post-commit: version-write failure:** inject version write fault → migration committed, version file missing, step 7 "done" with warning. Next upgrade → backfill (case b).
- [ ] **Post-commit: A3 failure:** inject fault in `reconcileAssemblerSettingsFile` → migration committed, a3Pending true, version written, step 7 "done" with warning.
- [ ] **Prompt cleanup (cases a/b):** active + version ≥ 2 + stale prompt file → prompt deleted.
- [ ] **Prompt cleanup failure (non-fatal):** inject unlink fault → step 7 succeeds, warning logged.
- [ ] **Idempotency:** run step 7 twice on A-class → first migrates, second hits case (a) and skips.

## Assumptions

- [ ] `refreshSplitInstructions` is called ALWAYS in step 7 (Design §5, step 4 in the sequence) — it deploys assets, recovers transactions, and refreshes. This is already the case in current code (`self-upgrade.js:748`).
- [ ] `ctx.tempDir/templates` contains the new version's templates, which is the correct source for both `templatesDir` and the instruction catalog. Already the case (`self-upgrade.js:722`).
- [ ] The instruction catalog path from the new version is at `ctx.tempDir/data/instruction-baselines/manifest.json` (relative to `PACKAGE_ROOT` which is `ctx.tempDir` for upgrade).
- [ ] B-class auto-migration is an empty set in the upgrade context (no provenance source for un-migrated machines). This is the authoritative P2 position (`docs/dev-plan-issue-722-p2.md:43,137`) and is accepted, not a gap.
- [ ] C-class machines are a minority of the fleet (per P2 analysis: most machines are A-class with unmodified ZYLOS.md).

## Acceptance Checklist

- [ ] A-class fixture: full migration — backup with report+migrationMeta (using `conservation.matched`), marker active, version `2`, A3 converged.
- [ ] C-class fixture: prompt file written with correct content, shard emits it at session start, no migration.
- [ ] Case (a): version ≥ 2 + active → skip, normal refresh.
- [ ] Case (b): active + version missing → backfill version `2`, normal refresh.
- [ ] F1 fault: zero live mutation, PENDING MIGRATION fallback.
- [ ] F2 fault (clean rollback): files restored, backup preserved, PENDING MIGRATION fallback.
- [ ] F2 fault (rollback failure): residue preserved, backup preserved, retry converges.
- [ ] Post-commit faults: migration committed, version/A3/residue handled per matrix.
- [ ] Full Jest + Node regression green (including CLI refactor).
- [ ] Real-machine test: on this box (already migrated), verify step 7 hits case (b) → backfills version file cleanly.
