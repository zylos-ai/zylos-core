# Memory Sync procedures

Read this file completely before running the selected procedure. Use these
installed command paths; `~/zylos` is the default ZYLOS_DIR (substitute the
inherited absolute ZYLOS_DIR when different).

| Script | Installed path |
|---|---|
| sync-lock.js | `~/zylos/.claude/skills/zylos-memory/scripts/sync-lock.js` |
| sync-files.js | `~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js` |
| origin-cursor.js | `~/zylos/.claude/skills/zylos-memory/scripts/origin-cursor.js` |
| reference-index.js | `~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js` |
| memory-append.js | `~/zylos/.claude/skills/zylos-memory/scripts/memory-append.js` |
| request-rotation.js | `~/zylos/.claude/skills/zylos-memory/scripts/request-rotation.js` |
| c4-fetch.js | `~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js` |
| c4-db.js | `~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js` |
| c4-send.js | `~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js` |

The zylos-memory scripts, c4-fetch.js, and c4-db.js accept `--help` or `-h`
without reading/writing run data or acquiring a lock. Use argv, or safely
quoted shell commands. Send summaries, JSON, and
message bodies on stdin using a quoted heredoc. Never interpolate body text
into a command. Group names come only from the inherited session binding.

## Common completion and failure rules

Acquire with `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-lock.js acquire --kind <group|origin|global>`; retain the
printed token T. An acquire exit 2 is a normal no-op only when stderr's first
line says `Error [SYNC_BUSY]`. `LOCK_TIMEOUT` is a failure. On any acquire
failure, do not release because no token was acquired.

After acquisition, `TOKEN_MISMATCH` / exit 3 means the lock is no longer
yours: stop immediately (no more writes, other script/tool operations, or
prompts, except removing this run's own private export directory below), then
release once with `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-lock.js release --kind <kind> --token T` and report. Release removes the marker only while it still carries T, so it
never removes another worker's lock.

For normal Sync CLI argument validation and `edit_memory` fragment validation,
correct the following call errors and retry only that failed operation at most
TWO times per step (the initial call plus at most two corrected retries).
These attempts do not fail the required step or release its token:

- `INVALID_INPUT`: correct the arguments or input content, including a missing
  required CLI argument. A missing or malformed token is a call error, not lost
  ownership: `edit_memory` and token-taking scripts return `INVALID_INPUT`
  (exit 1) with `token is required: pass the T printed by sync-lock.js acquire`.
  Pass T as `token` to `edit_memory` or `--token T` to scripts and retry under
  this same per-step limit; the lock is still yours.
  If a token error is `TOKEN_MISMATCH`, use the immediate-stop rule above.
- `FRAGMENT_CONFLICT`: reread the current file, reconsider the edit, and supply
  a unique expected fragment.
- `EXISTS`: for a single-file create/archive/unarchive collision, reread the
  existing pages and choose another name or merge through the permitted writer.
- `STATE_DOCUMENT_INVALID`: correct the token-named temporary state through
  `edit_memory`, then retry commit; the formal state has not been replaced.

This allowance applies only where validation rejected the operation before
publishing its target. It does not cover migration apply outside this Sync
flow, which can retain backups on validation errors. It also excludes
`node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js move-old`: a later collision can follow an already completed
move. Report that failure and preserve all prior moves; do not retry it
automatically. Never replay a committed prefix or restart a sequence to retry
one failed operation. Earlier checkpoints, file edits, and successful moves stay.

If two corrected retries still fail, use the applicable failure handling below.
Every later step uses these rules before treating a call as failed.
`INPUT_CHANGED` also receives no retry: its checkpoint/commit checks reject
before publishing that operation's target, but changed inputs can invalidate an
already completed checkpoint summary. Preserve that checkpoint, temporary state
and segments, stop later writes, release once and report the mismatch. Do not
replace the retained input manifest or replay a completed checkpoint to force a
commit. A later Sync must fully reread and reconcile the actual inputs.
`WRITE_FAILED`, `LOCK_UNAVAILABLE`, `LOCK_TIMEOUT`, and tool protocol errors
receive no retry. For any other required-step failure, stop later writes, release once with
`node ~/zylos/.claude/skills/zylos-memory/scripts/sync-lock.js release --kind <kind> --token T`, and report failure to the
requesting session with the steps already committed. On success or no input,
release exactly once too. If release fails, append that warning to the original
result; do not replace the original outcome or retry release. Never use an
unrestricted writer to repair a tool failure.

Before creating any export, run `mktemp -d` to create a unique private directory
(mode 0700), retain its returned path, and put every export inside it. Never
reuse a fixed filename in shared `/tmp`, or redirect conversation text into a
second file. `--out` creates each file exclusively with mode 0600. On success,
no input, or failure, remove only this run's private directory and its exports
with `rm -r "<absolute path of this run's private directory>"` before releasing
the token; report a cleanup failure. After TOKEN_MISMATCH, use the same command
to remove only this run's own private export directory, then release once and
report. Do not add `-f`. No script-side cleanup state or new background mechanism
is involved.

`LEGACY_READ_ONLY` is not a required-step failure: old `reference/projects.md`,
`reference/decisions.md`, and `reference/legacy/**`
are read-only through `edit_memory`, even when an old path no longer exists.
Redirect that change to its project/topic page and continue this Sync normally.
A failed `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js rebuild` is reported without blocking progress.
After any applicable corrected retries, audit failures are also report-only.
The immediate-stop token rule above applies throughout every procedure.

For example, an Origin/global worker calls the restricted `edit_memory` tool
with the actual acquired token substituted for T and an exact fragment read
from the target (paths are relative to memory):

```json
{"op":"edit","path":"reference/projects/example.md","expected":"- **Status:** planning","replacement":"- **Status:** active","token":"T"}
```

Do not call a shell writer for this edit. The same token is required when
creating the temporary state with `{"op":"create","path":"state.md.T.tmp","replacement":"<complete state document>","token":"T"}`;
Group Sync uses `session-groups/G/state.md.T.tmp` instead.

Use the restricted tool name discovered and passed by the parent (Claude:
`mcp__zylos-memory__edit_memory`; Codex: `mcp__zylos_memory__edit_memory`). If
absent, discover an exposed tool ending in `edit_memory` before concluding it
is unavailable. If the restricted tool is missing, report `TOOL_UNAVAILABLE`, do not commit,
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

Truncated tool output is unread. Retry a fetch with a smaller `--limit`, or a
file read with smaller byte ranges; read all required records before progress
advances. For an exported batch or listed input, read the entire file in bounded
byte ranges and verify its reported byte count and SHA-256 with read-only tools.
A hash check or first/last markers do not replace reading the content. Keep
export file hashes separate from batch receipt hashes: receipt `sha256` hashes
the canonical projected database rows, not the rendered export file bytes.

Use byte ranges even when a file contains one very long line. For example,
`dd if="<returned absolute path>" bs=1 skip=0 count=8192 status=none` reads
bytes [0,8192). Continue at skip=8188, then 16376, increasing by 8188 until the
reported file size is reached; the four-byte overlap keeps UTF-8 characters
readable across boundaries. Each command must return its actual text, not
counts, grep matches, word frequencies, or a summary. If output is truncated,
reduce the range and reread it. Record every completely read half-open range
`[start,end)` (end capped at file size); the ranges must cover every byte with
no gap. Include this per-file range ledger in the Sync result. Never claim a
full read from a hash match or analysis of an unread suffix. This byte method
preserves direct/export byte parity and valid JSON without adding hard wrapping.

### Complete byte-range reads

For every exported file and every listed input, complete these reading steps
before summarizing, checkpointing or advancing its cursor:

1. Read the entire file in bounded byte ranges and record every `[start,end)`.
   Truncated output is unread; reduce the range and reread it.
2. After the full text read, display the last 64 bytes of every exported file
   and every listed input with
   `tail -c 64 "<returned absolute path>" | od -An -v -c`.
   A file shorter than 64 bytes is displayed in full. This makes trailing spaces,
   tabs and newlines visible in only a few lines, even when the final text range
   is 8192 bytes. Repeat for every file; do not skip files or crop this display
   further. Truncated output is unread and must be reread.
   This supplements the text read and does not replace it.

## Group Sync

This also applies to the origin group's own working state. Set kind=group;
G is the inherited `ZYLOS_SESSION_GROUP`.

1. Acquire. Read `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js unsummarized --group G --json`. If count is zero,
   release and report no input. Do not cleanup, rotate, or consume inbox.
2. Fetch `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --unsummarized --group G --up-to <safeEnd> --limit <batchLimit> --out <FILE>`.
   Stdout is metadata: count, first/last IDs, file bytes and SHA-256, and a batch
   receipt `{"scope":...,"after":...,"end":...,"sha256":...}`. Read the full
   batch file and verify its bytes/hash. Save its rows, latest summary, and the
   receipt unchanged. This batch's returned end, rather than a later observed
   frontier, is the checkpoint target. A read
   failure ends the run before any cleanup/rotation.
3. Run `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js cleanup --token T`, then `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js rotate --token T`.
   Run the read-only `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js list`.
   No token is needed; a supplied `--token` is ignored.
   Save the complete returned object as `inputs`:
   `{"scope":...,"statePath":"<absolute state path>","segments":[{"id":...,"path":"<absolute>","bytes":...,"sha256":...}],"sessions":[{"path":"<absolute>","bytes":...,"sha256":...}]}`.
   Read state only at the returned `statePath`. Session selection starts at
   state `synced_at`'s date; an unknown/invalid date selects the latest seven
   calendar days. The script returns the paths; never choose or glob them.
   Read each `sessions[].path` individually; do not glob the `sessions/` directory.
   Read every listed segment in segment-ID order and every listed session file,
   in full; verify each byte count/hash. Use only the returned absolute paths,
   never constructed segment/session names. A missing state starts from an
   empty four-section state. A bad header means no committed segment set:
   include all uncommitted inputs.
4. Compare state coverage with the latest content checkpoint. If behind, use
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --checkpoints --group G --after <coverage>` to read **all**
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
7. Send the summary on stdin to
   `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js checkpoint <batch-end> --token T --batch '<receipt JSON>'`.
   Checkpoint recomputes and verifies the receipt against the database rows.
   Only after success, use `edit_memory` to create/edit
   `session-groups/G/state.md.T.tmp` relative to memory. Then send JSON
   `{"followedUpIds":[],"batch":<receipt>,"inputs":<complete list object>}`
   on stdin to `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js commit --token T`, replacing the empty array only
   with proven followed-up IDs. Commit verifies the batch, checkpoint coverage,
   the exact current segment IDs, absolute paths and hashes, and the state's
   segment IDs. Session logs are read inputs, but are not immutable commit
   inputs: a main-session note appended during Sync must not reject commit.
   Handle mismatches under the common rules; never omit inputs or fabricate a receipt to retry.
   Commit preserves the formal state's remaining absorbed lines and original
   title byte-for-byte, removing the title only when every item is removed.
8. Check the resulting content, release once, and report. Do not edit shared
   self knowledge during group Sync; the checkpoint carries relevant learning
   for Origin Sync. Ordinary user replies are outside this worker.

## Origin Sync

This is a separate job from the origin group's working-state Sync. It only
runs in the origin session, uses kind=origin. Its only sync-files operation is
the read-only `list --group G` below; never run group cleanup/rotate/commit.

1. Acquire, then read `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js origin-sync backlog --json`. No candidates means
   release and return. Process oldest bookmarks first. The raw-row budget is the
   Origin budget resolved above; checkpoint summaries do not consume it. Create
   this run's private export directory as in the common rules.
2. For each candidate G, export
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --origin-sync --group G --summaries-only --out <private dir>/<n>-summaries`
   (n is a run-local counter). Stdout is metadata: the absolute `path`, `count`,
   `firstId`, `lastId`, `bytes`, `sha256`, and a summary `receipt`
   `{"scope":...,"after":...,"end":...,"coverageEnd":...,"count":...,"sha256":...}`.
   Save the receipt unchanged; C is its `coverageEnd`. Read the whole file at
   the returned path by the byte-range rule above (8192-byte ranges with a
   four-byte overlap), including when it is one long JSON line. A truncated range
   is unread: reread it in smaller ranges. If that group's export or read fails
   after applicable corrected retries under the common rules,
   skip its merge and cursor advance, record why, and continue other groups
   under the common failure rules. The immediate-stop token rule applies.
3. If budget remains, export
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --origin-sync --group G --raw-only --after C --limit <remaining> --out <private dir>/<n>-raw`,
   using the saved C. Deduct the metadata `count`, save its raw `receipt`
   (`scope`, `after`, `end`, `count`, `sha256`) unchanged, and read the whole
   file the same way. A limited read's receipt ends at its last returned row;
   the cursor cannot move past it. If this export or read fails after applicable
   corrected retries under the common rules, neither cursor
   for G advances. With budget exhausted, skip the raw export; the raw receipt
   is then `null`.
4. For each group actually processed, run the read-only
   `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js list --group G`
   and save the complete returned object as that group's `inputs`. The script
   chooses the first log date from G's Origin cursor update (the latest seven
   calendar days when there is no cursor), in the configured timezone. Read each
   returned `sessions[].path` in full. It returns only scope and sessions for
   `--group`; it never reads candidate state or inbox. No export, group or log
   paths or globs may be constructed by the worker.
   Failed required logs prevent that
   group's merge/advance. For projects and decisions, read the complete category
   `INDEX.md` first (a missing INDEX is an empty table), then read only the
   relevant pages in full. If unmatched, Grep that category including `archive/`,
   then follow "Moving from old files" below before creating a page. Other
   shared files are read as before. Deduplicate facts and associate each
   necessary edit with its input groups.
5. Apply necessary shared edits through `edit_memory`, limited to identity,
   references, reference/** and users/**. Use a unique expected fragment, or
   create a missing file. Projects and decisions are written only to pages in
   their new directories, never to old files or `legacy/`. Update the page's
   `Status`/`Updated` header and append dated progress, then run
   `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js rebuild`. On `LEGACY_READ_ONLY`, redirect the edit to
   the corresponding page; this does not fail the step. Report a rebuild
   failure without blocking cursor advancement. Use the common corrected-call
   retry rule for necessary edits. A group
   with unfinished necessary edits cannot advance; if several depend on one
   failed shared edit, all those groups remain unadvanced. Partial committed
   files stay; there is no cross-file rollback.
6. For a substantive identity change already written, call
   `node ~/zylos/.claude/skills/zylos-memory/scripts/request-rotation.js --reason identity`. Report TRANSITION_OPEN or enqueue
   failure as rotation incomplete; it does not undo the identity write or
   block successful groups' cursor advancement. Do not promise an automatic retry.
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
   Check shared file
   content/size as part of the audit. In the Sync report, write one result sentence
   for each item: what was done, why no action was needed, or what failed.
   1. Run `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js rebuild`.
   2. When `navigation.count` is nonzero, inspect the reported locations.
      Only after rebuild succeeds and both category INDEX files exist, replace
      references.md navigation that still names the old files as read/write
      locations with `reference/projects/INDEX.md` and
      `reference/decisions/INDEX.md`. Otherwise report why navigation was not changed.
      Include navigation lines that still refer to the old paths, even if they
      describe those files as read-only history.
   3. Apply the archive/restore rule below: archive eligible completed or abandoned
      pages, and restore archived pages mentioned again. Check every INDEX row
      whose Status is completed/abandoned and Updated is about 30 days old or
      older; archive every eligible row. Report if none qualify.
   4. When `headings.count` is nonzero, inspect the reported locations.
      Once old files have moved into `reference/legacy/`, replace pointers to old
      headings with the matching page or, if no page exists, the legacy archive
      file, including navigation lines that still refer to the old paths.
      Report if there are no such pointers or the old files remain in place.

   Audit errors follow the common retry/report-only rules and do not block
   advancement. The immediate-stop token rule applies. For each successful group run
   `node ~/zylos/.claude/skills/zylos-memory/scripts/origin-cursor.js advance --group G --token T` with stdin
   `{"summary":<summary receipt>,"raw":<raw receipt or null>,"inputs":<list --group G result>}`,
   all exactly as returned. The script recomputes both receipts from the
   database and the session-log list, then sets the summary cursor to the
   summary receipt's `end` and the raw cursor to the raw receipt's `end`; without
   a raw receipt, new summaries move the raw cursor to max(S,min(C,upTo)) and no
   new summary means no advance. Never supply cursor numbers. A missing or
   malformed `--token` is the call error in the common rules. Any other
   rejection leaves both cursors for that group unchanged. Correct call errors
   only under the common per-step retry limit; after those retries, report the
   rejection and continue eligible groups under the common failure rules.
   `INPUT_CHANGED` receives no retry and stops later writes under the common
   terminal-input rule. Never replace a saved receipt to force advancement.
8. Cross-group correlation prompts. Prompt only **strong** correlations: both
   groups' records point to the same task, the same object, or the same person's
   same matter (including commitments that contradict each other). A similar
   topic is not enough. At most three prompts per run.
   - **Once per correlation.** Before prompting, Grep the relevant project
     pages in `reference/projects/` (including `archive/`) and the old file or
     `reference/legacy/` for the matching record. Each correlation is recorded
     at the end of its related project page as
     `Correlation between groups A and B notified at <time>`; a correlation
     already recorded is not prompted again unless something new has happened
     (for example a new conflict). Do not keep a separate table or file of sent
     prompts. If no project page fits, create an ordinary project page with
     both group names in `Keys`; when created only for this correlation record,
     set `Status: completed` and archive it later by the normal rule.
   - **Order.** Write that record as part of the necessary shared edits
     **before** cursor advance; send only after those writes/advances, via
     `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js internal G` with stdin.
   - **Fixed format.** Each recipient group gets exactly this text, with the
     placeholders filled in (one sentence each) and nothing else:
     ```
     [Correlation notice] Your "<this group's matter, one sentence>" relates to "<the other group's matter, one sentence>" in <other session group>: <why, one sentence>. Pointer: <C4 #id, checkpoint #id, or sessions/<date>.md>. For details, ask that group directly (node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js internal "<other group>"); no need to reply to this message.
     ```
     Pointers only, never raw logs. The prompt is a hint, not an instruction,
     and must be self-contained: the recipient may not have read the latest memory.
   - Do not send to origin itself; correlations involving origin go into the
     report (step 9). A rejected send is reported without deleting the record or
     automatic retry. A crash between recording and sending can lose the prompt.
9. Release once and report advanced/unadvanced groups, reasons, prompt recipients,
   and correlations involving origin for its running thread to decide on.

## Single global Sync

Use kind=global, no `ZYLOS_SESSION_GROUP`, global memory paths, and the global
C4 chain. Follow Group Sync's read-before-cleanup, recovery, summary, temporary
state, commit, and failure sequence, with these differences:

- Omit every `--group` on unsummarized/checkpoint reads. Never read group folders.
  Multiple source groups still yield one global checkpoint.
- As in Group Sync, run the read-only `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js list`.
  No token is needed; a supplied `--token` is ignored.
  Retain its full object, read/verify every listed file, and supply it as
  `inputs` to commit. Pass the unchanged batch receipt to checkpoint and commit
  as above.
- After reading global state, segments, and dated logs, read shared self files
  using the same INDEX → relevant pages → optional old-file lookup as Origin
  step 4. Complete necessary shared edits through `edit_memory` **before**
  checkpoint, writing projects/decisions only into pages. `LEGACY_READ_ONLY`
  means redirect the change to the corresponding page and continue, not a
  failed self-write. After applicable corrected retries, any other necessary self-write failure stops checkpoint,
  temporary state, and commit; release once and report. Already written
  fragments remain. Before checkpoint, follow the Origin step 7 checker and
  conditional checklist, and include one result sentence per item in the Sync
  report. Audit errors, including rebuild failure, follow the common rules and
  do not block checkpoint.
- After a substantive identity write, request rotation. Failure is reported
  but checkpoint/state/release still proceed; do not claim it will retry itself.
- The temporary file is `state.md.T.tmp` relative to memory. Preserve absorbed
  items by supplying only proven followedUpIds to commit, as in Group Sync.
- Release once and report.

## Moving from old files

When no matching project or decision topic appears in the category INDEX or
Grep of its pages (including `archive/`):

1. Search the old file if it still exists, otherwise `reference/legacy/`.
   Search names and aliases with line numbers, then read from a matched heading
   to the next heading at the same level. Search with `grep -n` or `rg -n`
   (Grep is also allowed when available); read with Read offset/limit or
   `sed -n '<a>,<b>p'`. Do not read an entire old file into a script.
   Do not use `cat` or print an entire old file, and never write old files.
   Read from the newest sections backward and stop when the current situation
   is clear.
2. Create a page with the current status (`completed` if the old text says it
   has ended). Under a "Moved from old projects.md" section, retain only what
   is still needed: current situation, unfinished work, key decisions and
   rationale. Use original facts; preserve original wording when uncertain.
   Record the old headings in `Moved from`, then append this round's progress.
3. Put new decisions in a topic page. If creating that topic page, Grep the old
   decisions file for the topic and bring over still-valid decisions directly
   relevant to the new decision, marking those that have been superseded.
4. Do not edit old files or mark their sections as moved. After a page has been
   created and indexed, use it directly on later matches rather than rereading
   the old file.

This same lookup and page creation applies when the only source is in
`reference/legacy/`: move the needed facts into a category page, record its old
heading in `Moved from`, and rebuild. Never recreate the old projects.md or
decisions.md path or write into legacy files.
For ongoing work found only in legacy, create the corresponding project or
decision category page with `Moved from`; do not write it into infrastructure.md
or leave it in group state. Group Sync carries it in its checkpoint for Origin
to perform this shared-page lookup and creation; it does not write shared pages.

## Archive and restore

The Sync Agent judges whether a project is done or abandoned and untouched for
about a month, or all decisions in a topic have been superseded; use
`node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js archive --path reference/projects/<name>.md`, leave paused projects in place, and
use `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js unarchive --path reference/projects/archive/<name>.md` when mentioned again.
Every `--path` is relative to the memory directory and includes the category
folder; decision-topic pages use `reference/decisions/<name>.md` or
`reference/decisions/archive/<name>.md` instead.
For an archive/unarchive `EXISTS` collision, both pages remain unchanged;
use the common corrected-call retry rule before moving again.
