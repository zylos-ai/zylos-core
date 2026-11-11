# One-time Reference Reorganization

Script names below mean `node <ZYLOS_DIR>/.claude/skills/zylos-memory/scripts/<name>`;
`c4-*` scripts are in the sibling `comm-bridge/scripts/` directory.

This procedure is for an owner-approved one-time reorganization, not Memory
Sync. Ordinary Sync immediately uses the new project and decision directories
and moves useful old material only as it is needed. This procedure finishes
moving the remaining ongoing material, then archives the old files unchanged.

## Find the private conversation and ask

The session that hears the owner's agreement starts the work. Ask only in the
owner's private conversation; memory file structure is internal information.

Find the owner's most recent private chat with:

```sh
node <ZYLOS_DIR>/.claude/skills/comm-bridge/scripts/c4-db.js groups --active-since <milliseconds-30-days-ago> --json
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
Send that text verbatim with only the placeholders filled in; add nothing.

Ask once in the owner's language, covering only three points: you would like to
reorganize the memory files; it will take some time; afterwards memory sync will
be faster and less likely to miss or duplicate records. Ask whether they agree.
Do not proactively mention duration, cost, models or file locations. Answer those
questions truthfully if the owner asks.

After asking, record one inbox commitment saying where you asked and that owner
agreement means starting this procedure. This lets a replacement session
understand what "agree" refers to.
Include in that commitment itself: refusal or no reply needs no memory update;
the system will ask again after seven days.

If the owner declines or does not reply, write no new memory afterward: no
decision page, no state entry, and no further inbox item. Keep the question-time
commitment as it is; do not rewrite it into a lasting conclusion such as
"the owner does not want reorganization" or "wait for the owner to ask".
On the next proposal, ask the owner once as usual.
Previous refusal or no reply, however recent, is not a reason to skip asking.
The seven-day interval is the only pacing rule.
The proposal mechanism alone records the last question time and does not ask
again within seven days; do not add or change a record yourself.

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

The worker processes every item itself. It must not spawn subagents or delegate
items in parallel.
Relay the worker's report faithfully, without overstating it. The worker's
notification is the only completion message; unless the owner asks, send no
additional follow-up message.

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
   First check the old source paths. If the old files have already moved into
   `reference/legacy/` and are no longer at their original paths, reorganization
   is finished: stop without creating or rebuilding `reorg-progress.md` or sending
   another completion notice. If just one source remains, process that source.
   Use `reference-index.js create --path reference/reorg-progress.md`:

   ```markdown
   # Memory reorganization progress
   - Notify: <channel>:<endpoint>
   - Started: YYYY-MM-DD HH:mm

   ## projects.md
   - [x] L1 ## Pages sharing password
   - [ ] L813 ## Project continuation
   - [ ] L900 ### Pending production work
   ## decisions.md
   - [ ] L1 ## Module policy
   ```

   Notify is the address where the owner agreed. Obtain Started from the system
   clock when creating the page; preserve it on resumption. List the old files'
   `##` headings individually, with line numbers. Preserve each full
   heading verbatim; do not truncate it to 100 characters. In both single and
   multi mode, split sections exceeding about 64 KiB into checklist items:
   keep the `##` line as an item covering only the text before the first `###`;
   each `###` line covers its own subsection.
   Each `###` subitem is an independent checkbox line starting with `- [ ]` at
   column one, never an indented or nested list item. If there are no `###` headings,
   keep the original item and read it in consecutive bounded parts. If a subitem still exceeds
   64 KiB, read it in consecutive bounded parts through its end before checking
   it off. Line numbers are reading starting points; verify against the exact
   heading text. Search with `grep -n` or `rg -n` (Grep is also allowed when
   available); read with Read offset/limit or `sed -n '<a>,<b>p'`.
   Do not read an entire old file into a script. Do not use `cat`
   or print an entire old file, and never write old files.

2. **Read each item in full, process it, then mark it checked.** Read from its
   heading through the next heading at the same or higher level (for a split
   `##` item, stop before its first `###`), using consecutive reads
   if needed. Do not read only the latest status block, and never check an item
   without reading all of it. Identify every ongoing matter anywhere in the item
   and create a page or merge it into an existing page. Count as ongoing either
   work still listed in current state.md (in multi mode, Origin's
   `session-groups/origin/state.md`), or work
   updated within 30 days and not marked completed or abandoned in the old
   section. For the latter, use Updated when present, otherwise the heading date;
   if several dates occur, use the latest. These are the only two sources for
   this judgment. Treat other work as ended and leave it in the old file for archival;
   ordinary Sync can move it later when needed. Do not read group checkpoint
   summaries for this judgment.

   Check off an item only in the batch in which you have read it in full.
   Do not use scripts or a single bulk operation to check off items. Do not use
   helper scripts to truncate or summarize sections. If you cannot finish,
   stop and leave unread items unchecked.

   For decisions, group pages by topic, not date ranges or old heading blocks.
   Move still-effective decisions into topic pages; leave
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

4. **Finish only when the full progress page has zero unchecked items.** Before
   `move-old`, count every `- [ ]` occurrence across the entire progress page,
   including all subitems, not only top-level items. Only a count of zero allows
   `move-old`; otherwise continue processing the unchecked items. This is the
   worker's check, not a completion check added to the script. Do not run
   `move-old` unless every item
   has been read in full and processed individually; a zero count alone does
   not establish that. Never bulk-check items to reach zero. Read Notify from
   the progress page before moving it. Run `reference-index.js move-old` to move
   the two old files and the progress page into `reference/legacy/` with date/time filenames,
   without overwriting. Then run `reference-index.js rebuild`. Tell the owner
   “The memory files have been reorganized” in the owner's language at Notify.
   The background worker inherits the spawning session's sending identity;
   in multi mode that is the thread owning this private conversation, so it can
   notify the owner there directly.

If `move-old` returns `EXISTS`, it does not overwrite; report it.

## Interruption and resumption

- If the worker stops because of context exhaustion, an error or session
  replacement, the old files remain, completed pages remain usable and the
  progress page keeps its checkmarks. Ordinary Sync continues moving useful
  material as needed.
- When a Claude or Codex background worker finishes, its spawning session
  receives the result. If unchecked items remain, start another worker.
  Relay its report faithfully without overstating it. The worker's notification
  is the only completion message; unless the owner asks, send no additional
  follow-up message, including after a later "continue" instruction.
- If the spawning session was replaced and receives no result, old files still
  exist, so the proposal mechanism will propose again after the seven-day
  interval. A session receiving a proposal with an existing progress page
  resumes without asking the owner again. In multi mode, Origin routes this to
  the thread owning the address in Notify. The owner can also say “continue
  reorganizing.”
- If two workers overlap after session replacement, create and memory-write
  prevent them overwriting one another. On `EXISTS` or `MEMORY_CONFLICT`, reread and merge. A later move-old
  skips old source files already absent.
- If an old file changes or disappears mid-process, add no special handling.
  Changes are archived with the old file; move-old skips a missing file.
