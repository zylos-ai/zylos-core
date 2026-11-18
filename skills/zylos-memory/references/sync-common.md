# Common Sync safety and reading rules

Read this file completely with the selected procedure. Memory Sync is maintenance: do not perform business tasks, send user replies, change project code, install components, or restart services. All memory content edits use the exact restricted edit_memory tool passed by the parent; never native Edit/Write/patch or shell redirects. Do not write ZYLOS.md, group rules.md, handoff.md or custom startup instructions. Do not clear a handoff because its messages are checkpointed. Use these
installed command paths; `~/zylos` is the default ZYLOS_DIR (substitute the
inherited absolute ZYLOS_DIR when different).

| Script | Installed path |
|---|---|
| sync-run.js | `~/zylos/.claude/skills/zylos-memory/scripts/sync-run.js` |
| sync-lock.js | `~/zylos/.claude/skills/zylos-memory/scripts/sync-lock.js` |
| sync-files.js | `~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js` |
| origin-cursor.js | `~/zylos/.claude/skills/zylos-memory/scripts/origin-cursor.js` |
| reference-index.js | `~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js` |
| memory-status.js | `~/zylos/.claude/skills/zylos-memory/scripts/memory-status.js` |
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

Group Sync uses sync-run.js start instead of manual acquire/export, summarize instead of checkpoint+prepare, finish instead of commit+release, and abort for terminal failure. The rules below still govern every outcome; only Origin/global run the manual commands. start releases on its own failure or no-input result, so do not release again. A summarize/finish validation error retains the token for the corrected-call rules; terminal failure requires abort exactly once. Report cleanup warnings returned by start/finish/abort, including after successful publication.

Acquire with `node ~/zylos/.claude/skills/zylos-memory/scripts/sync-lock.js acquire --kind <group|origin|global>`; retain the
printed token T. `edit_memory` calls cannot read shell variables or files; the `token` field must contain the literal token printed by acquire. An acquire exit 2 is a normal no-op only when stderr's first
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
- `STATE_DOCUMENT_INVALID`: correct `state.md.tmp` through
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
A batch or receipt that no longer matches the current conversation or checkpoint
rows is `INPUT_CHANGED`, not a correctable argument error. Stop this Sync run;
do not re-export, replace its saved receipts, or read only a diff to repair it
in the same run. Remove this run's private export directory, release the lock
once, and report failure to the parent session. Start again only in a later
Sync run, reading the complete new exports.
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
report. Do not add `-f`. Origin/global keep this manual cleanup. Group Sync uses sync-run.js abort/finish instead; its token directory and saved receipt are script-owned.

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

Do not call a shell writer for this edit. After checkpoint, run
`node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js prepare --token T`.
The script chooses from actual state bytes: `mode:"rewrite"` above 20480 bytes
(no copy), or `mode:"edit"` at or below budget (exclusive byte-for-byte copy).
Follow that returned mode, never choose it from a model estimate. For edit mode,
use unique expected/replacement fragments at `state.md.tmp`. For rewrite mode,
create a complete compact state with `edit_memory`; only current work, pending
items and blockers remain. A missing state returns `reason:"STATE_MISSING"`
and also needs a complete new document:
`{"op":"create","path":"state.md.tmp","replacement":"<complete state document>","token":"T"}`.
For Group and Global Sync, the tool maps this fixed name to the current scope's
token-named temporary file automatically; no group or token substitution in the path is needed.

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

Truncated tool output is unread. Recover it under the bounded read-retry rules
below; read all required records before progress advances. For an exported
batch or listed input, read the entire file in bounded byte ranges.
Use reported byte counts only as byte-range read endpoints.
A hash check or first/last markers do not replace reading the content. Keep
export file hashes separate from batch receipt hashes: receipt `sha256` hashes
the canonical projected database rows, not the rendered export file bytes.

Use byte ranges even when a file contains one very long line. For example,
`dd if="<returned absolute path>" bs=1 skip=0 count=8192 status=none` reads
bytes [0,8192). Continue at skip=8188, then 16376, increasing by 8188 until the
reported file size is reached; the four-byte overlap keeps UTF-8 characters
readable across boundaries. Each command must return its actual text, not
counts, grep matches, word frequencies, or a summary. Use one range per
top-level tool call as specified below.
Record every completely read half-open range
`[start,end)` (end capped at file size); the ranges must cover every byte with
no gap. Include this per-file range ledger in the Sync result. Never claim a
full read from a hash match or analysis of an unread suffix. This byte method
preserves direct/export byte parity and valid JSON without adding hard wrapping.

### Complete byte-range reads

For every exported file and every listed input, complete these reading steps
before summarizing, checkpointing or advancing its cursor:

1. Read the entire file in bounded byte ranges and record every `[start,end)`.
   Run **one byte range per top-level tool call**, returning that range's actual
   text before requesting the next. Do not batch ranges in loops (shell or
   JavaScript), parallel calls, or any wrapper that accumulates several reads
   into one return. On Codex, use a direct `exec_command` when exposed as a
   top-level tool; in code mode, each range needs its own `functions.exec`
   invocation containing one `exec_command`. Separate inner calls inside one
   outer invocation still share the outer output cap. On Claude, use one Bash
   call containing one `dd` command per range. Use Bash byte reads for long
   single-line JSON: Read's offset/limit select lines and cannot bound one long
   line by bytes. Start at 8192 bytes in both runtimes; if the runtime has a
   smaller configured output cap, start smaller. Preserve the four-byte overlap
   when advancing: next start is the last completely read end minus four.
   After reducing the size, keep that smaller size for the rest of the file.
   Never advance from a truncated range or add it to the completed ledger.
2. After the full text read, display the last 64 bytes of every exported file
   and every listed input with
   `tail -c 64 "<returned absolute path>" | od -An -v -c`.
   A file shorter than 64 bytes is displayed in full. This makes trailing spaces,
   tabs and newlines visible in only a few lines, even when the final text range
   is 8192 bytes. Repeat for every file; do not skip files or crop this display
   further. Truncated output is unread and must be reread in a fresh top-level
   call under the bounded read-retry rules below.
   This supplements the text read and does not replace it.

### Bounded read retries and reporting

For a truncated byte-range response, retry from the same unread start in a
**new top-level call**, halving the requested count (8192, 4096, 2048, 1024).
Allow at most three retries at that unread start (four attempts including the
initial read). If starting smaller, halve that count instead; stop if it would
become four bytes or fewer, because overlap must still allow forward progress.
After a complete range advances the ledger, the next start has its own retry
budget. Do not reset the budget merely by splitting or renaming the same
unread range. Truncation at either the inner or outer tool boundary counts as
an unread attempt, even if the command exited zero. A truncation marker,
persisted-output preview, omitted-line notice, or missing range text is not a
complete read.

For a truncated direct fetch, use at most three smaller-`--limit` retries in
fresh top-level calls, halving to a minimum of one; stop if one still truncates.
This does not authorize replacing an already saved export or receipt after
`INPUT_CHANGED`. Tail displays may be retried at most three times in fresh
calls, keeping all 64 bytes. A real I/O/tool error remains a read failure under
the common rules; these truncation retries do not relax other failure rules.

A truncated response becomes a read failure only after its retry budget is
exhausted. Apply the selected procedure's existing failure handling, preserving
its commit gates: no summary, checkpoint, state commit or cursor advance from
incompletely read inputs.
For a global conversation-batch read, failure also precedes input cleanup and rotation. Group Sync start has already rotated inbox before reading; uncommitted segments survive failure and are listed in full by the next run. No checkpoint or state commit is allowed before complete reads. Removing this run's private export directory and releasing its
lock still follow the common rules. Do not change receipts, skip unread bytes,
or restart Sync to make the run succeed.

In the final Sync result, include each file's completed range ledger and report
whether truncation occurred. When recovered, name the affected ranges, retry
counts and successful range size, and continue the run normally; recovered
truncation alone is not a failed Sync or a request for owner action. On failure,
report the unread range, attempted sizes/count, and the I/O error or exhausted
retry budget, together with any earlier committed steps. Do not claim a commit
or full read that did not occur.
