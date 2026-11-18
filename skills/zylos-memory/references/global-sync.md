# Single global Sync procedure

Read [common safety and reading rules](sync-common.md) and [writing rules](sync-writing.md) and [state format](state-format.md) completely. Use the manual working-state steps below with these global differences; never invoke sync-run.js for global Sync.

## Single global Sync

Use kind=global, no `ZYLOS_SESSION_GROUP`, global memory paths, and the global
C4 chain. Follow the working-state steps below: read-before-cleanup, recovery, summary, temporary state, commit, and failure sequence, with these differences:

- Omit every `--group` on unsummarized/checkpoint reads. Never read group folders.
  Multiple source groups still yield one global checkpoint.
- In these working-state steps, run the read-only `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js list`.
  No token is needed; a supplied `--token` is ignored.
  Retain its full object, read every listed file in full, and supply it as
  `inputs` to commit. Pass the unchanged batch receipt to checkpoint and commit
  as in the working-state steps below.
- After reading global state, segments, and dated logs, read shared self files
  reading each complete category INDEX first, then relevant pages in full (a missing INDEX is an empty table), then the [old-file lookup](sync-writing.md#moving-from-old-files) when unmatched. Complete necessary shared edits through `edit_memory` **before**
  checkpoint, writing projects/decisions only into pages. `LEGACY_READ_ONLY`
  means redirect the change to the corresponding page and continue, not a
  failed self-write. After applicable corrected retries, any other necessary self-write failure stops checkpoint,
  temporary state, and commit; release once and report. Already written
  fragments remain. Before checkpoint, follow the Shared audit section below checker and
  conditional checklist, and include one result sentence per item in the Sync
  report. Audit errors, including rebuild failure, follow the common rules and
  do not block checkpoint.
- After a substantive identity write, request rotation. Failure is reported
  but checkpoint/state/release still proceed; do not claim it will retry itself.
- Use the same guarded `prepare` mode selection (oversized rewrite or within-budget
  fragment edits), complete state read, status reconciliation, soft budget and
  per-item checkpoint result lines as the working-state steps below. For global Sync, record
  completed/superseded results in project pages yourself through the required
  shared edits before checkpoint; do not hand them off to Origin Sync, which
  does not run in single mode. During a full rewrite, rules, lessons and pitfalls
  already saved elsewhere get only a one-line pointer to their source file in
  state, not their full text. Use `state.md.tmp`; the tool selects this scope's token-named temporary file. Preserve absorbed
  items by supplying only proven followedUpIds to commit, as in the working-state steps.
- Release once and report.


## Working-state steps

1. Acquire. Read `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js unsummarized  --json`. If count is zero,
   release and report no input. Do not cleanup, rotate, or consume inbox.
2. Fetch `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --unsummarized  --up-to <safeEnd> --limit <batchLimit> --out <FILE>`.
   Stdout is metadata: count, first/last IDs, file bytes and SHA-256, and a batch
   receipt `{"scope":...,"after":...,"end":...,"sha256":...}`. Read the full
   batch file in byte ranges. Save its rows, latest summary, and the
   receipt unchanged. This batch's returned end, rather than a later observed
   frontier, is the checkpoint target. Recover truncated output using the bounded
   read retries above. A read failure ends the run before any cleanup/rotation.
3. Run `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js cleanup --token T`, then `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js rotate --token T`.
   Run the read-only `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js list`.
   No token is needed; a supplied `--token` is ignored.
   Save the complete returned object as `inputs`:
   `{"scope":...,"statePath":"<absolute state path>","segments":[{"id":...,"path":"<absolute>","bytes":...,"sha256":...}],"sessions":[{"path":"<absolute>","bytes":...,"sha256":...}]}`.
   Read the entire state at the returned `statePath`, in all bounded byte ranges
   with no gaps, before reconciling or preparing changes. This is mandatory for
   both rewrite and edit mode, even when only one fact changed. Apply the common
   complete-read and visible-tail rules to state too. Session selection starts at
   state `synced_at`'s date; an unknown/invalid date selects the latest seven
   calendar days. The script returns the paths; never choose or glob them.
   Read each `sessions[].path` individually; do not glob the `sessions/` directory.
   Read every listed segment in segment-ID order and every listed session file,
   in full. Use only the returned absolute paths,
   never constructed segment/session names. A missing state starts from an
   empty four-section state. A bad header means no committed segment set:
   include all uncommitted inputs.
4. Compare state coverage with the latest content checkpoint. If behind, use
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --checkpoints  --after <coverage>` to read **all**
   missing content summaries. Empty or unknown coverage uses 0. Do not recover
   from only the latest summary; two interrupted runs may leave several.
5. Reconcile old state, all difference summaries, this batch, segments, and logs
   by facts. Prepare a checkpoint summary including every inbox item absorbed
   this round, and state changes containing current focus, genuine pending work and blockers.
   Reconcile changed statuses in their original entries: replace stale status
   text instead of appending a contradictory "merged" or "completed" note for the
   same work. Remove completed and superseded entries this round, including old
   ones found during the full state read. When prepare returns rewrite, rebuild
   a compact state from the fully read facts, aiming for <=20 KiB; do not carry
   the old completed narrative into the new document. In edit mode, change only
   the necessary fragments, including removing stale completed entries.
   Target the 20 KiB soft budget (STATE_BUDGET_BYTES in sync-files.js). Before
   removing each completed or superseded item, include one result line per item
   in this round's checkpoint summary and record the result on its project page through restricted shared edits before checkpoint. Preserve all unresolved
   work and pending absorbed messages even if they exceed the budget.
   The commit script fills `inbox_committed` from this round's listed segments;
   a prepared copy may retain its old value, while a newly created state leaves
   it empty. Set coverage to the batch end; in edit mode change only that field.
   Preserve a valid `synced_at` from the existing state/skeleton as a temporary
   placeholder (or `1970-01-01T00:00:00Z` when neither exists); do not calculate
   or round a new timestamp. Commit validates the
   header format and overwrites this field with its actual UTC publication time.
6. For any absorbed-message block in Pending, use actual progress and C4 source
   messages to identify followed-up IDs. An outbound audit row alone does not
   prove delivery; uncertain or failed sends are not completion evidence.
   Do **not** rewrite or manually copy the block. Leave any script-copied
   block unchanged; commit strips that copy and preserves the official lines. Keep a separate
   `followedUpIds` array; no progress means an empty array.
7. Send the summary on stdin to
   `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js checkpoint <batch-end> --token T --batch '<receipt JSON>'`.
   Checkpoint recomputes and verifies the receipt against the database rows.
   Only after success, run
   `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js prepare --token T`.
   Follow the structured result:
   - `mode:"rewrite"`: the current state is over 20480 bytes. No temporary copy
     was made. Use `edit_memory` to create a complete compact four-section
     `state.md.tmp` from the fully read state and reconciled facts. Target <=20 KiB
     by removing completed/superseded entries with the result lines already saved
     in this checkpoint. For rules, lessons and pitfalls already saved elsewhere,
     keep only a one-line pointer to their source file in state, not their full
     text. Do not manually copy the absorbed block; commit restores
     its remaining official lines.
   - `mode:"edit"`: the script copied the state byte for byte into this token's
     temporary file. Use `edit_memory` unique-fragment replacements at
     `state.md.tmp`, including coverage; do not replace the whole document. Update
     statuses in their original entries, not additional conflicting notes.
   - `reason:"STATE_MISSING"`: create the complete initial state through
     `edit_memory` at `state.md.tmp`.

   All modes retain a valid existing timestamp or the fixed placeholder and
   use this scope's valid header. Repair a damaged header through a unique
   fragment in edit mode; in rewrite mode create a valid new header. Retain all
   unresolved work. Existing drafts are never overwritten: EXISTS means inspect
   the current draft under the common corrected-call rules. The restricted tool
   selects this scope's token-named file. Then send JSON
   `{"followedUpIds":[],"batch":<receipt>,"inputs":<complete list object>}`
   on stdin to `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js commit --token T`, replacing the empty array only
   with proven followed-up IDs. Commit verifies the batch, checkpoint coverage,
   the exact current segment IDs, absolute paths and hashes, then writes those
   segment IDs into the published state header and sets `synced_at` from the
   script clock at publication, in UTC with milliseconds. The worker-supplied
   timestamp is always overwritten. Commit outputs `stateBytes`,
   `stateBudgetBytes` (20480), and `stateOverBudget` after publication, including
   preserved absorbed lines. A true overflow flag is report-only: do not retry
   or discard unresolved work to clear it. Session logs are read inputs,
   but are not immutable commit inputs: a main-session note appended during Sync
   must not reject commit.
   Handle mismatches under the common rules; never omit inputs or fabricate a receipt to retry.
   Commit preserves the formal state's remaining absorbed lines and original
   title byte-for-byte, removing the title only when every item is removed.
8. Check the resulting content, release once, and report. Complete shared edits as required by the global differences above. Ordinary user replies are outside this worker.


## Shared audit

7. Before any cursor advance or checkpoint, run the read-only
   `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js check-navigation`. Its JSON contains
   `navigation: {count, locations}` for references.md old-path navigation and
   `headings: {count, locations}` for old-heading pointers; each location has
   `path`, `line`, and `text`. The checker reads shared identity/references,
   reference pages (including archived pages), and user profiles. It skips
   legacy sources, the old monolithic files, generated indexes, and working
   histories. In fields starting with `- **Moved from:** `, old-file names followed
   by straight- or curly-quoted titles are excluded, including multiple titles
   and titles with parenthetical notes. Any old-file references remaining in the
   field still count, as do references in prose. Heading-pointer candidates conservatively include plain old-file
   references as well as anchors and file:line references; inspect the reported
   lines before choosing a replacement.
   Use the corresponding count to decide whether
   item 2 or 4 needs manual inspection. A zero count means report "no action
   needed" for that item and skip its manual inspection. If the check fails,
   report it and inspect both items manually; do not assume a zero count.
   Execute items 1 and 3 every run, including on the first Sync with no pages.
   Check shared file content as part of the audit. Run
   `node ~/zylos/.claude/skills/zylos-memory/scripts/memory-status.js` to measure
   `identity.md` and `references.md` against both startup character and estimated-token
   limits; do not infer their status from byte sizes. In the Sync report, explicitly
   list either file reported as `WARN` or `OVER`, including its reported character
   and estimated-token usage. If both files are `OK`, state that both are within
   the warning thresholds. Report any missing file or command failure instead of
   assuming the files fit. This is an audit result, not an extra owner/system alert, and does
   not block writes. In the Sync report, write one result sentence
   for each item: what was done, why no action was needed, or what failed.
   1. Run `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js rebuild`.
   2. When `navigation.count` is nonzero, inspect the reported locations.
      Only after rebuild succeeds and both category INDEX files exist, replace
      references.md navigation that still names the old files as read/write
      locations with `reference/projects/INDEX.md` and
      `reference/decisions/INDEX.md`. Otherwise report why navigation was not changed.
      Include navigation lines that still refer to the old paths, even if they
      describe those files as read-only history.
   3. Apply the [archive/restore rule](sync-writing.md#archive-and-restore): archive eligible completed or abandoned
      pages, and restore archived pages mentioned again. Check every INDEX row
      whose Status is completed/abandoned and Updated is about 30 days old or
      older; archive every eligible row. Report if none qualify.
   4. When `headings.count` is nonzero, inspect the reported locations.
      Once old files have moved into `reference/legacy/`, replace pointers to old
      headings with the matching page or, if no page exists, the legacy archive
      file, including navigation lines that still refer to the old paths.
      Report if there are no such pointers or the old files remain in place.


For old-file lookup and archive/restore, follow [writing rules](sync-writing.md#moving-from-old-files).
