# Memory Sync procedures

Read this file completely before running the selected procedure. Script names
below mean `node <ZYLOS_DIR>/.claude/skills/zylos-memory/scripts/<name>`;
`c4-*` scripts are in the sibling `comm-bridge/scripts/` directory. Use absolute
paths and argv, or safely quoted shell commands. Send summaries, JSON, and
message bodies on stdin using a quoted heredoc. Never interpolate body text
into a command. Group names come only from the inherited session binding.

## Common completion and failure rules

Acquire with `sync-lock.js acquire --kind <group|origin|global>`; retain the
printed token T. An acquire exit 2 is a normal no-op only when stderr's first
line says `Error [SYNC_BUSY]`. `LOCK_TIMEOUT` is a failure. On any acquire
failure, do not release because no token was acquired.

After acquisition, `TOKEN_MISMATCH` / exit 3 means stop immediately: no more
script/tool operations, no release, no prompts. For any other required-step
failure (including `WRITE_FAILED` for a failed write/publication, `LOCK_UNAVAILABLE`
for an unavailable kernel lock, or a tool protocol error), stop later writes, release once with
`sync-lock.js release --kind <kind> --token T`, and report failure to the
requesting session with the steps already committed. On success or no input,
release exactly once too. If release fails, append that warning to the original
result; do not replace the original outcome or retry release. Never use an
unrestricted writer to repair a tool failure.

If the restricted tool is missing, report `TOOL_UNAVAILABLE`, do not commit,
and release once if T was obtained. A checkpoint may already have committed;
leave remaining inputs for recovery in a later triggered Sync. A crash or failed
commit does not justify deleting inputs. Do not start another Sync merely to
repair leftovers when there are no new conversations.

## Sync limits

Resolve limits once for this run using the same source order as the supervisor:
first the inherited environment variable, then its key in
`<ZYLOS_DIR>/.zylos/config.json`, then the default. A value that is not a positive
integer is unset and falls through to the next source. `batchLimit` uses
`ZYLOS_SYNC_BATCH_LIMIT` / `sync_batch_limit` / 200. The Origin raw-row budget
uses `ZYLOS_ORIGIN_SYNC_THRESHOLD` / `origin_sync_threshold` / 50. Keep the
resolved values for this run; do not substitute the defaults for configured
values in subsequent fetch commands.

## Group Sync

This also applies to the origin group's own working state. Set kind=group;
G is the inherited `ZYLOS_SESSION_GROUP`.

1. Acquire. Read `c4-db.js unsummarized --group G --json`. If count is zero,
   release and report no input. Do not cleanup, rotate, or consume inbox.
2. Fetch `c4-fetch.js --unsummarized --group G --up-to <safeEnd> --limit <batchLimit>`.
   Save its rows, latest summary, and returned batch end. The end printed for
   this batch, not a later observed frontier, is the checkpoint target. A read
   failure ends the run before any cleanup/rotation.
3. Run `sync-files.js cleanup --token T`, then `sync-files.js rotate --token T`.
   Read the current group state, then run the read-only `sync-files.js list`
   without `--token`; adding `--token` returns `INVALID_INPUT` and ends this run.
   Read every listed
   uncommitted segment in segment-ID order. Read dated session logs from the
   state's synced date onward; if the header/date is unknown, read the latest
   seven days. A missing state starts from an empty four-section state. A bad
   header means no committed segment set: include all uncommitted inputs.
4. Compare state coverage with the latest content checkpoint. If behind, use
   `c4-fetch.js --checkpoints --group G --after <coverage>` to read **all**
   missing content summaries. Empty or unknown coverage uses 0. Do not recover
   from only the latest summary; two interrupted runs may leave several.
5. Reconcile old state, all difference summaries, this batch, segments, and logs
   by facts. Prepare a checkpoint summary including every inbox item absorbed
   this round, and a new state containing current work. List all read segment
   IDs in its `inbox_committed` header, and put the batch end in coverage.
6. For any absorbed-message block in Pending, use actual progress and C4 source
   messages to identify followed-up IDs. An outbound audit row alone does not
   prove delivery; uncertain or failed sends are not completion evidence.
   Do **not** copy the block into the temporary state. Keep a separate
   `followedUpIds` array; no progress means an empty array.
7. Send the summary on stdin to `sync-files.js checkpoint <batch-end> --token T`.
   Only after success, use `edit_memory` to create/edit
   `session-groups/G/state.md.T.tmp` relative to memory. Then send JSON
   `{"followedUpIds":[...]}` on stdin to `sync-files.js commit --token T`.
   Commit preserves the formal state's remaining absorbed lines and original
   title byte-for-byte, removing the title only when every item is removed.
8. Check the resulting content, release once, and report. Do not edit shared
   self knowledge during group Sync; the checkpoint carries relevant learning
   for Origin Sync. Ordinary user replies are outside this worker.

## Origin Sync

This is a separate job from the origin group's working-state Sync. It only
runs in the origin session, uses kind=origin, and never calls sync-files.

1. Acquire, then read `c4-db.js origin-sync backlog --json`. No candidates means
   release and return. Save each group's cursorFrom S, upTo, and cursorUpdatedAt.
   Process oldest bookmarks first. The raw-row budget is the Origin budget
   resolved above; checkpoint summaries do not consume it.
2. For each candidate G, fetch
   `c4-fetch.js --origin-sync --group G --summaries-only`. Save C=coverageEnd
   and K=checkpointId from this same read alongside all summaries. If that
   group's read fails, skip its merge and cursor advance, record why, and
   continue other groups unless the failure is TOKEN_MISMATCH.
3. If budget remains, fetch
   `c4-fetch.js --origin-sync --group G --raw-only --after C --limit <remaining>`.
   Use the **saved first C**, never a newly read coverage. Deduct the actual row
   count. When the result is complete, the proposed raw cursor is saved upTo;
   when truncated it is the last returned ID. If this read fails, neither
   cursor for G advances. With budget exhausted, a group with new summaries may
   advance raw cursor to max(S,min(C,upTo)); with no new summary skip both cursors.
   The proposed summary cursor is the saved K, not a summary's covered end.
4. For each group actually processed, read its dated logs since cursorUpdatedAt's
   date. Do not read its state or inbox. Failed required logs prevent that
   group's merge/advance. Explicitly read the shared files you plan to change,
   deduplicate facts, and associate each necessary edit with its input groups.
5. Apply necessary shared edits through `edit_memory`, limited to identity,
   references, reference/** and users/**. Use a unique expected fragment, or
   create a missing file. On fragment conflict, reread and reconsider. A group
   with unfinished necessary edits cannot advance; if several depend on one
   failed shared edit, all those groups remain unadvanced. Partial committed
   files stay; there is no cross-file rollback.
6. For a substantive identity change already written, call
   `request-rotation.js --reason identity`. Report TRANSITION_OPEN or enqueue
   failure as rotation incomplete; it does not undo the identity write or
   block successful groups' cursor advancement. Do not promise an automatic retry.
7. Audit shared file content/size and references navigation. For each successful
   group call `origin-cursor.js advance --group G --synced <proposed-raw>
   --checkpoint <saved-K> --token T`. A cursor rejection leaves that group
   unadvanced; report it and continue eligible groups. TOKEN_MISMATCH stops
   everything, including release and internal prompts.
8. At most three strong cross-group correlations may be prompted. Check existing
   project notes to avoid repeating an association. Record the association and
   intended prompt as part of necessary shared edits **before** cursor advance;
   send only after those writes/advances, via `c4-send.js internal G` with stdin.
   Include one explanation and source pointers, not raw logs; do not send to
   origin itself. A rejected send is reported without deleting the record or
   automatic retry. A crash between recording and sending can lose the prompt.
9. Release once and report advanced/unadvanced groups, reasons, prompt recipients,
   and correlations involving origin for its running thread to decide on.

## Single global Sync

Use kind=global, no `ZYLOS_SESSION_GROUP`, global memory paths, and the global
C4 chain. Follow Group Sync's read-before-cleanup, recovery, summary, temporary
state, commit, and failure sequence, with these differences:

- Omit every `--group` on unsummarized/checkpoint reads. Never read group folders.
  Multiple source groups still yield one global checkpoint.
- As in Group Sync, run the read-only `sync-files.js list`.
  Do not add `--token`; doing so returns `INVALID_INPUT` and ends this run.
- After reading global state, segments, and dated logs, also read shared self
  files. Complete necessary shared edits through `edit_memory` **before**
  checkpoint. Any necessary self-write failure stops checkpoint, temporary state,
  and commit; release once and report. Already written fragments remain.
- After a substantive identity write, request rotation. Failure is reported
  but checkpoint/state/release still proceed; do not claim it will retry itself.
- The temporary file is `state.md.T.tmp` relative to memory. Preserve absorbed
  items by supplying only proven followedUpIds to commit, as in Group Sync.
- Audit references navigation/size, then release once and report.
