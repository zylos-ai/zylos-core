# Dev Plan: Upgrade-path auto-migration for instruction split (#729, P3)

## Summary

Make `zylos upgrade --self` automatically migrate A-class machines to the split-layer instruction architecture, and output a structured self-migration prompt for C-class machines so channel-only agents can resolve it without terminal access.

## Scope

**In:**
- Add `.zylos/instruction-format-version` protocol (the upgrade-path detection mechanism defined in Issue #729; write contract from P2 `docs/dev-plan-issue-722-p2.md:47`).
- Extract a shared migration engine (`executeMigrationApply`) from the CLI command — reused by both CLI and upgrade step 7, covering the full P2 contract.
- Modify `step7_syncInstructions`: singular executable sequence (read version → refresh/deploy/recovery → decide migration/backfill using refresh result + version state).
- A-class auto-migration in step 7.
- C-class: write structured prompt file + session-start shard to inject it into the agent's next session + closed lifecycle (cleanup after activation).
- Extend CLI active `--apply` front gate to backfill version file.
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
| `>2` | Future architecture version | Skip migration (forward-compatible — never run v2 migration) |
| Invalid/unreadable | Treat as missing | Attempt migration (with warning) |

**Single writer contract (per P2 `docs/dev-plan-issue-722-p2.md:47`):**

Ordering: marker commit (`commitEntries` rename, `instruction-builder.js:215-216`) → version write → A3.

The version file is written as a **separate atomic write** (temp + rename) immediately after `activateMigratedSplitInstructions` returns successfully, BEFORE `reconcileAssemblerSettingsFile`. It is NOT written inside `commitEntries` — it is a post-activation step.

Write points (each follows the same ordering contract):
- **Shared engine** (`executeMigrationApply`): writes after successful activation, before A3. This covers both the CLI `--apply` path and the upgrade step 7 auto-migration path.
- **`activateFreshSplitInstructions`**: writes after its `commitEntries` returns (fresh install path). This is a code addition to the existing function.
- **CLI active `--apply` front gate**: backfills version file if missing before A3 (see Design §8).

Version-write failure: non-fatal. Migration is success (marker is the source of truth). Emit stderr warning + remediation "rerun `--apply` to backfill the version file". Next upgrade reads version → missing → but `isSplitInstructionsActive()` is true → backfill (step 7 case b).

**Backfill:** Both the step 7 decision matrix (case b) AND the CLI active `--apply` front gate handle: marker active + version missing/stale → write version `2`.

### 2. Shared migration engine

Extract `executeMigrationApply()` into `cli/lib/instruction-migration.js`. This function is the apply path extracted from the CLI command (`cli/commands/migrate-instructions.js:212-302`), called by both CLI and upgrade step 7.

**Signature (every input sourced from its actual producer):**

```js
executeMigrationApply({
  zylosDir,            // path — caller provides
  templatesDir,        // path — caller provides (CLI: PACKAGE_ROOT/templates; step 7: ctx.tempDir/templates)
  original,            // string — raw ZYLOS.md content (caller reads fs)
  analysis,            // object — from classifyInstructionBaseline({original, catalog, provenance})
  userContent,         // string — content to MATERIALIZE as post-migration ZYLOS.md
                       //   A-class: fs.readFileSync(templatesDir/ZYLOS.md) (new seed template)
                       //   C-class via CLI: user-provided file content
  conservation,        // object — from verifyInstructionConservation (caller verifies BEFORE calling engine)
                       //   A-class conservation input: userContent='' (empty legacy contribution)
                       //   — the verification value and the materialized value are DISTINCT for A-class
  faultInjector,       // function — for commitEntries fault injection
  backupFaultInjector, // function — for createMigrationBackup fault injection
  reportIo,            // object — for updateFailureReport I/O seam
  settingsIo,          // object — for reconcileAssemblerSettingsFile I/O seam
})
```

**A-class conservation contract (per P2 `cli/commands/migrate-instructions.js:186-193`):**

Two distinct values for A-class:
- **Verification**: `verifyInstructionConservation({ strippedContent: analysis.strippedContent, userContent: '', catalog, matched: analysis.matched })` — empty string proves the original is pure system template with zero user additions.
- **Materialization**: `userContent = fs.readFileSync(templatesDir/ZYLOS.md)` — the new seed template written as post-migration ZYLOS.md.

The **caller** (step 7 or CLI) performs this separation before calling the engine. The engine receives the already-verified `conservation` result and the `userContent` to materialize.

**Contract (step-by-step, matching current CLI `migrate-instructions.js:212-302`):**

1. Compute `originalSha256 = sha256(original)`.
2. Build `baseReport` from: `analysis.classification`, `conservation.matched` (NOT `analysis.matched` — conservation may refine the match), `analysis.candidates`, `analysis.managedBlocks`, `userContent`, `originalSha256`, `conservation.attributionBaseline`, `conservation.attribution`.
3. `createMigrationBackup(...)` — failure → return `{ migrated: false, fatal: true, error }`. Zero live mutation (P2 F1).
4. `activateMigratedSplitInstructions(...)` — failure → enrich failure report → return `{ migrated: false, fatal: false, error, backupPath }`. Backup + failure report preserved (P2 F2).
5. Delete `.zylos/pending-migration-prompt.md` if exists (prompt lifecycle closure — see Design §4). Non-fatal, log warning on failure.
6. Write `.zylos/instruction-format-version` = `2\n` (atomic temp+rename) — failure → `{ versionWriteError }`, non-fatal.
7. `reconcileAssemblerSettingsFile({ zylosDir, apply: true, ... })` — failure → non-fatal. Migration committed, A3 pending.
8. Check `hasSplitTransactionResidue(zylosDir)` → `cleanupResidue`.

**Return type (non-contradictory result algebra):**

```js
{
  migrated: boolean,         // true iff activation committed (marker rename succeeded)
  fatal: boolean,            // true ONLY on backup failure (F1: zero live mutation)
                             // false for transaction failure (F2: backup preserved, may have residue)
  classification: string,
  backupPath: string | null, // null only when fatal (backup creation itself failed)
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

**Key distinction:** `fatal` = backup failure (F1, zero live mutation, no backup path); `!fatal && !migrated` = transaction failure (F2, backup preserved, may have residue). The caller must branch on `migrated`, not on exceptions.

**CLI refactor:** The CLI command (`migrateInstructionsCommand`) calls `executeMigrationApply` after its own arg parsing, dry-run checks, classification, user-content determination, and conservation verification. The existing CLI test suite must pass unchanged.

### 3. Production B is an empty set — scope narrowed to A + C

The classifier requires `provenance.seedSha256` for B classification (`instruction-migration.js:120-146`). In the upgrade auto-migration context:
- Marker missing → `refreshSplitInstructions` returns `pendingMigration: true` — no marker → no provenance source.
- Marker present → already active, `refreshSplitInstructions` refreshes and skips classification entirely.

There is no reachable state where provenance exists but migration is pending. This matches the authoritative P2 statement (`docs/dev-plan-issue-722-p2.md:43,137`): "legacy 机不存在任何 seed provenance ledger → 自动 B 集合为空是预期结果, 不是缺陷".

**Decision:** P3 auto-migration handles A-class only. C-class gets the agent self-migration prompt. B-class auto-migration would require an external provenance source (out of P3 scope; file as a future consideration if needed).

### 4. C-class prompt — closed lifecycle

**Prompt generation** (`writeMigrationPrompt`):
- File: `.zylos/pending-migration-prompt.md`
- Content: classification result, top-5 candidate baselines with similarity scores, original ZYLOS.md content hash, step-by-step agent instructions (read ZYLOS.md, identify system vs user content using candidates as reference, extract user content to temp file, run `zylos migrate-instructions --apply --user-content <file>`).

**Consumer — session-start shard:**

Add a new core shard `migration-prompt` to the `CORE_SHARDS` array in `shard-registry.js`. Exact 7-item array sequence after insertion:

```
[0] identity        (order 1)
[1] custom          (order 2)
[2] references      (order 3)
[3] state           (order 4)
[4] migration-prompt (order 5)   ← NEW
[5] c4-checkpoint   (order 6)   ← was order 5
[6] c4-conversations (order 7)  ← was order 6
```

Core shard chain order is determined by array position in `CORE_SHARDS` (`shard-registry.js:58-101`), not by sorting the numeric `order` field. Both the array position AND the `order` value must be updated. Registry comment (`shard-registry.js:11`) must be updated from "five" to seven. `cli/lib/sync-settings-hooks.js:76-81` shard count reference must also be updated. Both Claude and Codex chain tests must be updated to expect the 7-item chain.

Emitter behavior (state-based, not file-based):
1. Check `isSplitInstructionsActive()` — if **active**: suppress emission. If prompt file exists, delete it (defense-in-depth cleanup, non-fatal). Emit nothing.
2. If marker NOT active AND `.zylos/pending-migration-prompt.md` exists → read and emit content wrapped in `=== PENDING MIGRATION ===` header.
3. If marker NOT active AND file does NOT exist → emit nothing.

This closes the stale loop: even if all other cleanup paths fail, the shard itself suppresses and cleans up once the marker is active. The CLI active `--apply` gate returning early without consuming `--user-content` is no longer a problem — the shard won't re-emit regardless of file existence.

**Prompt write contract:** Atomic (temp + rename), same pattern as version file. Write failure → non-fatal, step 7 returns C-class message without prompt file (agent can still run `zylos migrate-instructions` manually). Partial write → impossible (atomic). Include in failure matrix and tests.

**Lifecycle closure (four cleanup paths, any one sufficient):**

1. **Engine cleanup (primary):** `executeMigrationApply` step 5 deletes the prompt file immediately after successful activation (marker committed). Covers CLI `--apply --user-content` path. Non-fatal.
2. **Step 7 cleanup (upgrade path):** cases (a) and (b) — active → delete stale prompt if exists. Non-fatal.
3. **CLI active `--apply` gate cleanup:** when marker active, delete prompt file if exists before A3. Non-fatal.
4. **Shard suppression + cleanup (defense-in-depth):** shard checks marker active → suppresses emission and deletes file. Non-fatal. This is the final safety net — if paths 1-3 all fail, the shard catches it at next session start.

**Tests:**
- C prompt written → CLI `--apply --user-content` succeeds → prompt deleted → shard silent.
- C prompt written → activation succeeds BUT unlink fails → shard checks marker active → suppresses + cleans → shard silent.
- Prompt atomic write failure → step 7 returns C-class message without prompt path, no partial file.
- Prompt unlink failure in engine → non-fatal, shard catches at next session.

### 5. step7_syncInstructions — singular executable sequence

One sequence, no contradictions:

```
Step 7 entry:
  1. (existing) Deploy manifest template
  2. (existing) Legacy migration if ZYLOS.md missing
  3. Read instruction-format-version → versionState

  4. FUTURE-FORMAT GATE (before any v2 code runs):
     If version > 2 → EARLY RETURN. Do not run refreshSplitInstructions, do not
     touch any instruction files/marker/assets. Return informational message:
     "future format version N; current v2 migration code does not apply".
     Rationale: refreshSplitInstructions runs v2 transaction recovery, parses
     v2 marker, and rewrites v2 assets/output — all of which would modify a
     future-format machine's state before the skip could take effect.

  5. Run refreshSplitInstructions (v2 code — safe because step 4 already
     excluded future formats)
     → refreshResult: { active, pendingMigration }

  6. Decision matrix (version ≤ 2 / missing / invalid × refreshResult):

     ┌─────────────────────────┬────────────────────────┬──────────────────────────────────┐
     │                         │ refreshResult.active   │ refreshResult.pendingMigration   │
     ├─────────────────────────┼────────────────────────┼──────────────────────────────────┤
     │ version === 2           │ (a) Normal refresh.    │ (d) Anomaly: v2 version file     │
     │                         │ Clean up stale prompt. │ but marker missing (corruption). │
     │                         │ Done.                  │ Attempt v2 migration with        │
     │                         │                        │ warning.                         │
     ├─────────────────────────┼────────────────────────┼──────────────────────────────────┤
     │ version < 2 / missing / │ (b) Backfill: write    │ (c) Attempt auto-migration.      │
     │ invalid                 │ version = 2.           │ Classify → A: auto-migrate.      │
     │                         │ Clean up stale prompt. │ C: write prompt.                 │
     │                         │ Done.                  │                                  │
     └─────────────────────────┴────────────────────────┴──────────────────────────────────┘

  7. Case (c) / (d) migration:
     a. loadInstructionCatalog({ catalogPath: <new version's catalog> })
     b. Read original ZYLOS.md content
     c. classifyInstructionBaseline({ original, catalog }) — no provenance supplied
     d. If classification A:
        - Verify conservation with EMPTY legacy user contribution:
          conservation = verifyInstructionConservation({
            strippedContent: analysis.strippedContent,
            userContent: '',      ← empty, proving original is pure system template
            catalog,
            matched: analysis.matched,
          })
        - If !conservation.ok → PENDING MIGRATION fallback (conservation refusal)
        - Materialize content: userContent = fs.readFileSync(templatesDir/ZYLOS.md)
        - result = executeMigrationApply({ ..., userContent, conservation })
        - Branch on result.migrated:
          * true → return success message with classification + backupPath
          * false → return PENDING MIGRATION fallback (+ backupPath if available)
     e. If classification C:
        - writeMigrationPrompt({ zylosDir, analysis }) — atomic write (temp+rename)
        - If write fails → return C-class message without prompt path (agent can
          still run `zylos migrate-instructions` manually), log warning
        - If write succeeds → return C-class message with prompt file path
  8. Clean up stale prompt file: cases (a) and (b) — active →
     delete .zylos/pending-migration-prompt.md if exists. try/catch, non-fatal.
```

**Future-format byte-for-byte guarantee:** Test with a fixture where version=3 and instruction files have non-v2 content → step 7 returns informational message → all fixture files byte-for-byte unchanged (no recovery, no asset rewrite, no marker modification).

**Step 7 result branching:** Step 7 does NOT use try/catch around the engine call. It calls `executeMigrationApply` and branches on the returned `result.migrated` boolean. `true` → success message. `false` → PENDING MIGRATION fallback with `result.backupPath` if available. The engine never throws for expected failures (backup/transaction) — it returns structured results.

### 6. Failure matrix (aligned with P2 F1/F2 + residue two-phase semantics)

**Upgrade step 7 failure semantics:** step 7 branches on `result.migrated` and returns PENDING MIGRATION fallback for any non-success. The upgrade itself must never fail because of a migration error.

| Phase | Failure point | Mutations | Residue | Engine result | Step 7 result |
|---|---|---|---|---|---|
| **Pre-mutation** | Catalog load, classify, conservation verify | None | None | (not reached) | PENDING MIGRATION fallback |
| **F1: Backup** | `createMigrationBackup` fails | Zero live mutation | Partial backup best-effort removed | `{migrated:false, fatal:true}` | PENDING MIGRATION fallback |
| **F2: Transaction** (clean rollback) | Activation throws, rollback succeeds | Files restored | No `.split-txn.*` residue; durable backup + failure report preserved | `{migrated:false, fatal:false, backupPath}` | PENDING MIGRATION fallback + backupPath |
| **F2: Transaction** (rollback failure) | Rollback itself fails | Indeterminate | `.split-txn.*` residue preserved | `{migrated:false, fatal:false, backupPath}` | PENDING MIGRATION fallback + backupPath |
| **Post-commit: prompt cleanup** | Prompt file unlink fails | Migration committed, prompt file remains | None | `{migrated:true}` (warning logged) | Success (shard suppresses at next session — marker active) |
| **C-class prompt write** | Atomic write fails | No prompt file, no migration | None | (not engine) | C-class message without prompt path; agent uses manual CLI |
| **Post-commit: version write** | Atomic write fails | Migration committed, version missing | None | `{migrated:true, versionWritten:false}` | Success with warning; next upgrade → backfill (case b) or CLI `--apply` backfills |
| **Post-commit: A3** | `reconcileAssemblerSettingsFile` fails | Migration committed, hooks not converged | None | `{migrated:true, a3Pending:true}` | Success with warning; `zylos migrate-instructions --apply` converges |
| **Post-commit: cleanup residue** | `commitEntries` bak cleanup fails | Committed `.bak` residue | `.split-txn.*.bak` preserved | `{migrated:true, cleanupResidue:true}` | Success; next `--apply` recovery front-gate cleans |

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

### 8. CLI active `--apply` front gate — version backfill

The current CLI active front gate (`cli/commands/migrate-instructions.js:96-114`) checks `isSplitInstructionsActive()`, runs A3, and returns. It does NOT write the version file — so the remediation "rerun `--apply` to backfill the version file" is currently unreachable.

**Fix:** Extend the active `--apply` gate to backfill version file before A3:

```
if active:
  backfill = writeInstructionFormatVersion if missing (atomic, non-fatal)
  a3 = reconcileAssemblerSettingsFile(...)
  return (with backfill status)
```

This closes the remediation loop: version-write failure during migration → user reruns `--apply` → CLI backfills version file → A3 converges. Idempotent: already-correct version file → no-op.

## Development Checklist

- [ ] Add `readInstructionFormatVersion({ zylosDir })` → `{ version: number | null, valid: boolean }` and `writeInstructionFormatVersion({ zylosDir, version })` (atomic temp+rename) helpers.
- [ ] Write version file in `activateFreshSplitInstructions` after `commitEntries` returns (fresh install path).
- [ ] Extract `executeMigrationApply()` from CLI command into `instruction-migration.js` with the exact signature, contract, and return type defined in Design §2. Include prompt file cleanup (step 5) inside the engine.
- [ ] Refactor CLI `migrateInstructionsCommand` to call `executeMigrationApply` — verify zero behavior change via existing CLI test suite.
- [ ] Extend CLI active `--apply` front gate to: backfill version file if missing + delete stale prompt file if exists, both before A3 (Design §8, lifecycle path 3).
- [ ] Add `writeMigrationPrompt({ zylosDir, analysis })` function with atomic write (temp+rename).
- [ ] Add `migration-prompt` core shard at array position [4] in `CORE_SHARDS` (`shard-registry.js`). Update `order` values for c4-checkpoint (5→6) and c4-conversations (6→7). Update registry comment (shard count). Update `cli/lib/sync-settings-hooks.js` shard count reference. Update both Claude and Codex chain tests.
- [ ] Add shard emitter script for `migration-prompt` (check marker active → suppress + cleanup; check file existence → emit or no-op).
- [ ] Modify `step7_syncInstructions` per Design §5: read version → refresh → 5-cell decision matrix → migration/backfill/cleanup. Step 7 branches on `result.migrated`, NOT try/catch.
- [ ] Prompt cleanup in step 7 cases (a)/(b): delete stale prompt file, non-fatal.
- [ ] Backfill in step 7 case (b): write version = 2 for marker-active + version-missing machines.

## Test Checklist

- [ ] **Version file helpers:** round-trip read/write, missing file → `null`, invalid content → `{ version: null, valid: false }`, atomic write.
- [ ] **Version file in fresh install:** `activateFreshSplitInstructions` → version file contains `2`.
- [ ] **CLI refactor regression:** all existing `migrate-instructions` Jest tests pass unchanged after extracting `executeMigrationApply`.
- [ ] **CLI active `--apply` version backfill:** active marker + version missing → `--apply` backfills version `2` before A3. Active + version present → no-op. Write failure → non-fatal warning, A3 still runs. Idempotent retry → no change.
- [ ] **A-class auto-migration (step 7 case c):** ZYLOS.md matches catalog baseline, no version file → conservation verified with `userContent: ''` → migration with materialized seed template → backup with report+migrationMeta (using `conservation.matched`), marker active, prompt file deleted (if existed), version `2` written, A3 reconciled, step 7 returns success.
- [ ] **A-class conservation correctness:** verify that A-class conservation passes with `userContent: ''` and fails with `userContent: templateSeed` on a real catalog A fixture.
- [ ] **C-class prompt output (step 7 case c):** C-class ZYLOS.md → no migration, `.zylos/pending-migration-prompt.md` written, step 7 message references prompt path.
- [ ] **C-class prompt lifecycle:** C prompt exists → CLI `--apply --user-content` succeeds → prompt file deleted by engine → next session shard emits nothing.
- [ ] **C-class prompt lifecycle (unlink failure):** engine unlink fails → prompt file remains → shard checks `isSplitInstructionsActive()` → active → shard suppresses emission AND deletes file → shard silent.
- [ ] **C-class prompt atomic write:** writeMigrationPrompt uses atomic temp+rename. Write failure → no partial file, step 7 returns C-class message without prompt path.
- [ ] **C-class shard consumer (pending):** marker NOT active + prompt file exists → shard emits content.
- [ ] **C-class shard consumer (active):** marker active + prompt file exists → shard suppresses, deletes file, emits nothing.
- [ ] **C-class shard consumer (clean):** marker active + no prompt file → shard emits nothing (zero cost).
- [ ] **Shard chain integrity:** 7-item chain in correct order: identity, custom, references, state, migration-prompt, c4-checkpoint, c4-conversations. Both Claude and Codex chain tests pass.
- [ ] **Already-migrated skip — version 2 (case a):** version `2` + active → no migration, normal refresh.
- [ ] **Backfill (case b):** active + version missing → version `2` written, normal refresh.
- [ ] **Forward-compat active (case a):** version `3` + active → skip migration (step 4 early return, refresh does NOT run).
- [ ] **Forward-compat pending (step 4 gate):** version `3` + no marker → early return BEFORE refresh, return informational message. No v2 code runs.
- [ ] **Future-format byte-for-byte:** version `3` fixture with non-v2 instruction files → step 7 early return → all files byte-for-byte unchanged (no recovery, no asset rewrite, no marker modification).
- [ ] **Anomaly (case d):** version `2` + pendingMigration → attempt migration with warning.
- [ ] **Pre-mutation failure:** inject fault before backup → step 7 PENDING MIGRATION fallback, zero live changes.
- [ ] **F1: Backup failure:** `createMigrationBackup` fault → `{migrated:false, fatal:true}`, step 7 PENDING MIGRATION fallback. Partial backup best-effort removed.
- [ ] **F2: Clean rollback:** activation fault, rollback succeeds → `{migrated:false, fatal:false, backupPath}`, no `.split-txn.*` residue, backup + failure report preserved. Step 7 PENDING MIGRATION fallback.
- [ ] **F2: Rollback failure:** rollback fault → `{migrated:false, fatal:false, backupPath}`, `.split-txn.*` residue preserved. **Retry convergence:** `--apply` → recovery front-gate → migration succeeds.
- [ ] **Post-commit: prompt cleanup failure:** prompt unlink fault → `{migrated:true}`, warning logged, shard re-emits next session.
- [ ] **Post-commit: cleanup residue:** committed `.bak` cleanup fault → `{migrated:true, cleanupResidue:true}`, version written. **Retry convergence:** `--apply` recovery cleans.
- [ ] **Post-commit: version-write failure:** version write fault → `{migrated:true, versionWritten:false}`, step 7 success with warning. CLI `--apply` → backfills. Next upgrade → case (b).
- [ ] **Post-commit: A3 failure:** A3 fault → `{migrated:true, a3Pending:true}`, version written. CLI `--apply` → converges A3.
- [ ] **Step 7 result branching:** engine returns `{migrated:false}` → step 7 emits PENDING MIGRATION (not success). Engine returns `{migrated:true}` → step 7 emits success. Verify at the step 7 caller seam, not just engine unit tests.
- [ ] **Prompt cleanup (cases a/b):** active + version ≥ 2 + stale prompt → deleted.
- [ ] **Prompt cleanup failure (non-fatal):** unlink fault → step 7 succeeds.
- [ ] **Idempotency:** step 7 twice on A-class → first migrates, second hits case (a).

## Assumptions

- [ ] `refreshSplitInstructions` is called ALWAYS in step 7 (Design §5, step 4) — handles asset deploy, recovery, refresh. Already the case (`self-upgrade.js:748`).
- [ ] `ctx.tempDir/templates` contains the new version's templates. Already the case (`self-upgrade.js:722`).
- [ ] The instruction catalog path from the new version is relative to `ctx.tempDir` (package root for the new version).
- [ ] B-class auto-migration is an empty set in the upgrade context. Authoritative P2 position (`docs/dev-plan-issue-722-p2.md:43,137`).
- [ ] C-class machines are a minority of the fleet.

## Acceptance Checklist

- [ ] A-class fixture: conservation with `userContent: ''` → full migration with seed materialization → backup, marker, prompt cleanup, version `2`, A3.
- [ ] C-class fixture: prompt file written (atomic), shard emits at session start (marker not active), CLI `--apply --user-content` cleans prompt, shard silent after (marker active → suppress).
- [ ] Case (a): version ≥ 2 + active → skip, refresh.
- [ ] Case (b): active + version missing → backfill.
- [ ] Step 4 gate: version > 2 → early return before refresh, byte-for-byte unchanged files.
- [ ] CLI `--apply` on active: backfills version if missing, A3 converges.
- [ ] F1 fault: zero live mutation, PENDING MIGRATION.
- [ ] F2 faults: backup preserved, result branching at step 7 caller seam.
- [ ] Post-commit faults: each handled per matrix.
- [ ] Shard chain: 7-item, both runtimes tested.
- [ ] Full Jest + Node regression green.
- [ ] Real-machine: this box → case (b), backfills version file.
