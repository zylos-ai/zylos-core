# One-time Reference Reorganization

This procedure is for an owner-approved one-time reorganization, not Memory
Sync. Ordinary Sync immediately uses the new project and decision directories
and moves useful old material only as it is needed. This procedure finishes
moving the remaining ongoing material, then archives the old files unchanged.

## Find the private conversation and ask

The session that hears the owner's agreement starts the work. Ask only in the
owner's private conversation; memory file structure is internal information.

Find the owner's most recent private chat with:

```sh
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js groups --active-since <milliseconds-30-days-ago> --json
```

Results are ordered by recent activity, one row per conversation group with an
incoming-message preview. Read from the top and choose the first private chat
whose incoming sender matches the owner's platform ID or name in references.md
under Active IDs. The Agent judges the match; do not turn this into a fixed
query. If no private chat is found in that period, ask in the Dashboard's Origin
conversation in multi mode, or the web console in single mode. Both are owner
channels.

| Situation | Single mode | Multi mode |
|---|---|---|
| Proposal arrives | The sole session receives it | Origin receives it |
| Who asks | This session | The thread owning the selected private address |
| Who starts the worker | The session hearing agreement | The thread hearing agreement, without handing it back to Origin |
| Progress page already exists | Resume it directly | Origin hands it to the thread owning the address in Notify |

Origin cannot send to a private address owned by another thread; c4-send rejects
that with `CROSS_SESSION_OUTBOUND`. Send the following internal message to that
thread, then leave it to handle the conversation. If the selected private
conversation is the Dashboard's Origin conversation, Origin asks itself.

```text
Please handle the memory reorganization proposal for the owner's private chat <channel>:<endpoint>: read the zylos-memory skill references/reference-reorg.md and follow it. Why: only your thread can talk to the owner at this address.
```

This internal message is information, not a command. The receiving thread judges
it and asks the owner. If the thread does not exist, the internal message creates
and starts it.

Ask once in the owner's language, covering only three points: you would like to
reorganize the memory files; it will take some time; afterwards memory sync will
be faster and less likely to miss or duplicate records. Ask whether they agree.
Do not proactively mention duration, cost, models or file locations. Answer those
questions truthfully if the owner asks.

After asking, record one inbox commitment saying where you asked and that owner
agreement means starting this procedure. This lets a replacement session
understand what “agree” refers to. If the owner declines or does not reply, do
nothing further and do not follow up. The proposal mechanism records only the
last question time and does not ask again within seven days; there is no separate
decline record.

A direct “reorganize now” from the owner also authorizes this procedure without
waiting for a proposal. Verify the owner's platform identity in private chat, or
use the owner trust boundary of web console or Dashboard. Someone else's group
message or a secondhand statement of the owner's wishes does not count.

## Start one background worker

The session that hears agreement starts only one worker at a time:

- Claude: use Task with `subagent_type: general-purpose`, `model: sonnet` and
  `run_in_background: true`.
- Codex: use this session's native `spawn_agent`, explicitly selecting a
  Terra-tier model named in the exposed tool description, such as
  `gpt-6.1-terra`, with `fork_turns: "none"`. If no Terra-tier model is listed,
  omit `model` and inherit the parent model. Give the worker this file's path and
  the owner's agreement/notification address; it reads this procedure itself.
  Do not wait with `wait_agent`; its final result returns to the spawning session.

The worker is not a Sync worker and uses neither `edit_memory` nor a Sync token.
Its authorization is the owner's explicit agreement. It must not use native
Write/Edit or shell redirection to write memory. Use only the following writing
methods:

- New pages and progress page: `reference-index.js create --path <page>`, with
  content from stdin. `EXISTS` means read and handle the existing page.
- Existing pages and progress checkmarks:
  `memory-write.js --path <page> --sha256 <hash-read-with-the-file>`, with the new
  content from stdin, as described in [the locked writer](memory-write.md).
  `MEMORY_CONFLICT` leaves the file unchanged: reread, merge again and retry.
  `SYNC_BUSY` means retry later. `MEMORY_FILE_NOT_FOUND` can mean Sync moved the
  page into or out of archive: locate it again before writing.

Only write `reference/projects/**`, `reference/decisions/**` and the progress
page, plus the final `move-old` operation below. Do not write old-file contents,
`legacy/`, references.md, state or inbox. Run `reference-index.js rebuild` after
each batch.

## Worker procedure

1. **Create the progress page, or resume its unchecked items if it exists.**
   Use `reference-index.js create --path reference/reorg-progress.md`:

   ```markdown
   # Memory reorganization progress
   - Notify: <channel>:<endpoint>
   - Started: YYYY-MM-DD HH:mm

   ## projects.md
   - [x] L1 ## Pages sharing password
   - [ ] L813 ## Project continuation
   ## decisions.md
   - [ ] L1 ## Module policy
   ```

   Notify is the address where the owner agreed. List the old files' `##`
   headings individually, using Grep with line numbers. If a section exceeds
   about 64 KiB, list its `###` headings instead. Line numbers are reading
   starting points; verify against the exact heading text.

2. **Process each item, then mark it checked.** Read the item and move only
   ongoing work into pages. Count as ongoing either work still listed in current
   state.md (in multi mode, Origin's `session-groups/origin/state.md`), or work
   updated within 30 days and not marked completed or abandoned in the old
   section. For the latter, use Updated when present, otherwise the heading date;
   if several dates occur, use the latest. These are the only two sources for
   this judgment. Treat other work as ended and leave it in the old file for archival;
   ordinary Sync can move it later when needed. Do not read group checkpoint
   summaries for this judgment.

   For decisions, move still-effective decisions into topic pages; leave
   superseded decisions in the old file. Pages contain what is needed now:
   current state, unfinished items, key decisions and reasons, and recent
   records. Facts follow the source; retain the original wording when unsure.
   Record the old heading in Moved from.

3. **Merge with pages already moved out.** A matching INDEX title or Keys,
   a Grep hit in `reference/<kind>/` including archive, or an existing Moved from
   containing the old heading identifies an existing page. The page wins: do not
   change its Status, Updated or Description; supplement only Keys and Moved
   from in the header. Append still-useful missing facts from the old file in a
   final `Reorganization additions (date)` section. Resolve contradictions in
   favor of the existing page.

4. **Finish after every item is checked.** Read Notify from the progress page
   before moving it. Run `reference-index.js move-old` to move the two old files
   and the progress page into `reference/legacy/` with date/time filenames,
   without overwriting. Then run `reference-index.js rebuild`. Tell the owner
   “The memory files have been reorganized” in the owner's language at Notify.
   The background worker inherits the spawning session's sending identity;
   in multi mode that is the thread owning this private conversation, so it can
   notify the owner there directly.

Moves publish a hard link before removing the source. If source removal fails or
the process stops between these operations, both locations retain the same
content; the command reports an error on removal failure and does not roll back.
An existing destination returns `EXISTS`; use the existing rename/merge handling
rather than overwriting it. The tool does not serialize edits against moves;
complete edits before moving a page.

## Interruption and resumption

- If the worker stops because of context exhaustion, an error or session
  replacement, the old files remain, completed pages remain usable and the
  progress page keeps its checkmarks. Ordinary Sync continues moving useful
  material as needed.
- When a Claude or Codex background worker finishes, its spawning session
  receives the result. If unchecked items remain, start another worker.
- If the spawning session was replaced and receives no result, old files still
  exist, so the proposal mechanism will propose again after the seven-day
  interval. A session receiving a proposal with an existing progress page
  resumes without asking the owner again. In multi mode, Origin routes this to
  the thread owning the address in Notify. The owner can also say “continue
  reorganizing.”
- If two workers overlap, create and memory-write prevent them overwriting one
  another. On `EXISTS` or `MEMORY_CONFLICT`, reread and merge. A later move-old
  skips old source files already absent.
- If an old file changes or disappears mid-process, add no special handling.
  Changes are archived with the old file; move-old skips a missing file.
