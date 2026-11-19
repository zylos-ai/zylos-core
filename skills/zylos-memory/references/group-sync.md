# Group Sync procedure

## Group Sync

Read [common safety and reading rules](sync-common.md) completely and [state format](state-format.md). Execute only group Sync with a bound inherited ZYLOS_SESSION_GROUP, including origin's own working state. Use kind=group; being in origin does not select Origin Sync. All memory content writes use the parent's exact restricted edit_memory tool. No shared self-knowledge edits or user replies.

## Prepare and read

Run `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-run.js start` once. It acquires its own token, checks backlog, exports the bounded batch, runs cleanup/rotate/list and exports **all** content checkpoints after valid state coverage (unknown/empty coverage uses 0). No input releases the token without cleanup/rotate or inbox changes; return that result. start failure releases itself; report its error and any cleanup warnings, without another release.

Retain the returned literal token T and manifest. The script saves receipt and the complete list object privately in the token's run directory; never copy them into commands or change run.json. The manifest supplies batch/summaries absolute paths, bytes and SHA-256; state metadata (null if missing); full inputs with statePath, ordered segments and sessions; and batch end. Read every exported file, the entire existing state, every listed segment in order and every listed session in full by the common Complete byte-range reads steps, including visible tails and the per-file ledger. Use reported byte counts only as byte-range read endpoints. Never synthesize paths. Truncated output is unread: use bounded read retries, one byte range per top-level tool call, in a fresh top-level call; do not batch ranges in loops. On Codex use direct exec_command when exposed, or its own functions.exec containing one exec_command.

Unlike the former manual sequence, inbox rotation happens before the model reads the batch. A failed read still prevents checkpoint/commit. Rotated notes remain uncommitted segments; abort removes only exports, and the next run lists and reads those segments. cleanup removes only segments already published in a valid state and stale drafts; no failed run consumes unread notes. A missing state starts with the four-section skeleton; invalid header means no committed segment set.

## Reconcile facts

Reconcile old state, all difference summaries, this batch, segments, and logs
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
in this round's checkpoint summary for Origin Sync to record on project pages;
group Sync still does not write shared references. Preserve all unresolved
work and pending absorbed messages even if they exceed the budget.
Preserve a valid `synced_at` from the existing state/skeleton as a temporary
placeholder (or `1970-01-01T00:00:00Z` when neither exists); do not calculate
or round a new timestamp. Commit validates the
header format and overwrites this field with its actual UTC publication time.
For any absorbed-message block in Pending, use actual progress and C4 source
messages to identify followed-up IDs. An outbound audit row alone does not
prove delivery; uncertain or failed sends are not completion evidence.
Do **not** rewrite or manually copy the block. Leave any script-copied
block unchanged; commit strips that copy and preserves the official lines. Keep a separate
`followedUpIds` array; no progress means an empty array.

## Save summary and prepare state

Send the full checkpoint summary on stdin with a quoted heredoc to `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-run.js summarize --token T`.
Checkpoint recomputes and verifies the receipt against the database rows; only successful checkpoint proceeds to prepare. A corrected prepare call never replays the completed checkpoint. Follow the structured result:
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


All modes retain a valid timestamp or the fixed placeholder and the scope's valid header. Repair damaged headers by a unique fragment in edit mode. Existing drafts are never overwritten: inspect EXISTS under the common corrected-call rules. Use only edit_memory at state.md.tmp with literal token T. Set coverage to the returned batch end. The commit script fills `inbox_committed` from this round's listed segments; a prepared copy may retain its old value, while a newly created state leaves it empty.

## Publish and report

Send only `{"followedUpIds":[]}` on stdin to `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-run.js finish --token T`, with IDs only when proven followed up. The script retrieves the saved receipt and list itself. Commit verifies the batch, checkpoint coverage, the exact current segment IDs, absolute paths and hashes, then writes those segment IDs into the published state header. It preserves remaining official absorbed lines and title byte-for-byte, stamps actual UTC publication time, and reports stateBytes/stateBudgetBytes/stateOverBudget. Overflow is report-only; preserve unresolved work. Session logs may grow during Sync without rejecting commit.

finish commits, removes this run's export directory and releases once. Report any cleanup/release warnings alongside the committed outcome; never repeat commit or release after a successful finish. For terminal failure before successful finish, call `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-run.js abort --token T` exactly once, then report the original error, earlier checkpoint/publication and cleanup warnings. TOKEN_MISMATCH stops other operations; abort only removes this token's own directory and conditionally releases it. start after stale-token acquisition cleans stale run exports, and cleanup removes stale drafts; the checkpoint summaries recover state lag from interrupted runs. Do not acquire a replacement token or start another Sync to repair this run.

Return outcome, checkpoint, state publication/budget, cleanup/release warnings, and the complete read ledger to the parent. Never claim unperformed reads or publication.
