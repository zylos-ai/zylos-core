# One-time Reference Reorganization

Script names below mean `node <ZYLOS_DIR>/.claude/skills/zylos-memory/scripts/<name>`.

This procedure runs only when the system sends the memory reorganization
instruction. It is separate from Memory Sync: rebuild pages only for in-progress
work listed in state files, then archive both old files unchanged into
`reference/legacy/`.

## Start one background worker

The session receiving the system instruction starts the work directly: the sole
session in single mode, Origin in multi mode. Do not hand it to another thread.
If a reorganization worker
this session started is still running, do nothing. Start only one at a time:

- Claude: use Task with `subagent_type: general-purpose`, `model: sonnet` and
  `run_in_background: true`.
- Codex: use this session's native `spawn_agent`, explicitly selecting a
  Terra-tier model named in the exposed tool description, such as
  `gpt-6.1-terra`, with `fork_turns: "none"`. If no Terra-tier model is listed,
  omit `model` and inherit the parent model.

Give the worker this file's path so it reads the procedure itself. Do not wait
for it with `wait_agent`; its final result returns to the spawning session.

## Worker procedure

1. **Identify in-progress work from state files only.** Read `memory/state.md`
   and every existing `memory/session-groups/*/state.md`, without first deciding
   whether this instance is single or multi. Include work that is still active,
   waiting for someone, or paused; skip completed work and entries that are only
   reminders or rules. Merge duplicate matters across the state files.

   In multi mode, global `memory/state.md` may still contain the last in-progress
   list from before a single-to-multi upgrade. Origin's state describes only its
   own conversation and can be empty; other groups have their own states. Read
   all of them. State files identify which matters are in progress; shared facts
   come from the old shared files, not from copying group state into pages.
   Do not infer in-progress work from dates in old sections. If all state files
   are missing or list no in-progress work, create no pages and go to step 4.

2. **Rebuild or supplement one project at a time.** For each matter:
   - First read both `reference/projects/INDEX.md` and
     `reference/projects/archive/INDEX.md`. Then search by project names and
     aliases with `grep -ril` in `reference/projects/` (including `archive/`)
     for matching names or `Keys`. A match is an existing page. If it is in
     `archive/`, first run
     `reference-index.js unarchive --path reference/projects/archive/<name>.md` because the project is in progress.
   - Read old sections pointed to by state first. Then search the old
     `projects.md` by name and aliases with line numbers; if it has left its
     original path, search the latest projects archive in `reference/legacy/`.
     Read only from a matching heading to the next heading at the same level,
     newest sections first, stopping when the current situation is clear.
     Search with `grep -n` or `rg -n` (Grep is also allowed when available);
     read with Read offset/limit or `sed -n '<a>,<b>p'`.
     Do not read an entire old file into a script. Do not use `cat`
     or print an entire old file, and never write old files.
     Search old `decisions.md` in the same way for decisions directly related to
     this project, using its latest archive if it has already moved. Include
     those facts in this project page's key decisions and reasons.
   - If no page exists, create one with `reference-index.js create` using the page
     format in [projects-format.md](projects-format.md) (Status is one of `active`,
     `planning`, `paused`, `completed`, `abandoned`). Its header describes the current status; its body contains the current situation,
     unfinished items, key decisions and reasons, and recent records. Record the
     old headings read in `Moved from`. Facts follow the source; retain the
     original wording when unsure.
   - Before changing an existing page, you must read it with
     `memory-write.js --read --path reference/projects/<name>.md`, which returns
     its complete text and the matching `sha256` together. The page is authoritative: do not change its `Status`,
     `Updated`, or `Description`. Supplement only `Keys` and `Moved from` in its
     header. Append useful missing old facts in a final section named
     `整理补充（<date>）`, and save through `memory-write.js`.

3. **Do not rebuild decision pages.** Do not generate topic pages from the old
   `decisions.md`. New decisions still go into `reference/decisions/` through
   ordinary Sync. To look up old decisions after archival, search
   `reference/legacy/` as described in the system memory directory guidance.
   Standing rules remain in `preferences.md`; do not change that file.

4. **Finish with rebuild, then move-old.** Run `reference-index.js rebuild`,
   then run `reference-index.js move-old` as a separate command, only after
   every `create`, `unarchive`, and `memory-write` operation in step 2 has
   returned `ok`. If any operation returns `SYNC_BUSY`, `MEMORY_CONFLICT`,
   or any other error, follow the writing rules and retry until it succeeds;
   do not run `move-old` while any write remains unsuccessful. This moves both old files intact into
   `reference/legacy/` with date-time filenames without overwriting existing
   files. If `move-old` returns `EXISTS`, nothing moved: report it in the result
   returned to the spawning session and do not retry. Build pages first and move
   old files last: once the original paths are absent, reorganization is finished.
   Do not leave replacement files or a completion marker at the original paths.

## Writing rules

Every `--path` is relative to the memory directory and includes the category
folder, for example `reference-index.js create --path reference/projects/<name>.md`,
`reference-index.js unarchive --path reference/projects/archive/<name>.md`, and
`memory-write.js --path reference/projects/<name>.md --sha256 <hash>`.
Do not create probe or test pages, and never delete, move or rename memory files
with shell commands such as `rm` or `mv`; if a command fails, read its error or
the script usage instead.

The worker is not Sync and uses neither `edit_memory` nor a Sync token. Its
authorization is the system's reorganization instruction. It must not use native
Write/Edit or shell redirection to write memory. Use these writing methods:

- New pages: `reference-index.js create --path reference/projects/<name>.md`, with content from stdin.
  `EXISTS` means read and handle the existing page.
- Existing pages: `memory-write.js --path reference/projects/<name>.md --sha256 <hash-read-with-the-file>`,
  with the new content from stdin, as described in [the locked writer](memory-write.md).
  Before editing an existing page, you must use
  `memory-write.js --read --path reference/projects/<name>.md` to read its
  complete text and matching `sha256` in one response. The write's `--sha256`
  must come only from that read response, the previous successful write result,
  or the `MEMORY_CONFLICT` response. Never use `sha256sum` or any command that
  does not print the page content to obtain the hash: that defeats conflict
  detection and may silently overwrite Sync's changes.
  Write out the complete new page content in a heredoc; do not generate it with
  `sed`, `awk`, or similar commands, whether piped directly into the writer or
  first saved to a temporary file.
  `MEMORY_CONFLICT` leaves the file unchanged: reread with
  `memory-write.js --read --path reference/projects/<name>.md`, merge again,
  and retry with the hash returned alongside the content.
  `SYNC_BUSY` means retry later. `MEMORY_FILE_NOT_FOUND` can mean Sync moved the
  page into or out of archive: locate it again before writing.

Only write `reference/projects/**` (including `unarchive`), the INDEX files
generated by `rebuild`, and the final `move-old` operation. Do not write pages
under `reference/decisions/`, old-file contents, `legacy/`, references.md, state,
or inbox.

## Interruption and resumption

If context runs out, an error occurs, or the session is replaced, old files stay
at their original paths and completed pages remain usable by ordinary Sync.
Do not record progress or automatically restart the worker. If old files remain
after interruption, an error, or `move-old` returning `EXISTS`, wait for the next
system instruction. The Supervisor sends it on the next Origin/global Sync request. Start again from step 1 and merge existing pages as in step 2;
do not create duplicate pages.

If two workers overlap after session replacement, `create` and `memory-write.js`
prevent overwriting: the later writer gets `EXISTS` or `MEMORY_CONFLICT`, rereads
with `memory-write.js --read --path reference/projects/<name>.md`, and merges. A later `move-old` with no original files left does nothing.
If an old file changes or disappears partway through, do not add special handling:
changes are archived with the file, and `move-old` skips absent files.
