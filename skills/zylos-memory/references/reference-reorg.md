# One-time reference reorganization

Run this procedure only on the system's reference reorganization instruction.
Archive the old aggregate `memory/reference/projects.md` and `decisions.md`
after supplementing the current project pages that still need those facts.

## Start one background worker

The receiving session starts the worker. If a worker it launched is still
running, leave it to finish. Use the current runtime's background mechanism.
For Claude, use a general-purpose Sonnet worker. For Codex, use the exact
Terra-tier model exposed by `spawn_agent` with `fork_turns: "none"`, or inherit
if none is listed. For Antigravity, use a Flash background worker. Pass this
procedure's absolute path so the worker can read it directly.

## Worker procedure

1. Read `memory/reference/projects/INDEX.md` and the project pages marked
   `active`, `planning` or `paused`. Use their `## Current` sections and status
   to identify unfinished matters. If there are no such pages, proceed to
   archival.
2. For each relevant page, search the old `projects.md` and `decisions.md` by
   project name and aliases. Read only the matching headings and their
   sections. If either aggregate has already moved, search its latest copy in
   `reference/legacy/`. Include only useful missing facts and decisions. Write
   the complete supplement as a dated section with `memory-write.js --append
   --path reference/projects/<name>.md`. When helpful, pass `--keys` and
   `--moved-from` to supplement those header values. Keep the current page's
   status, update date, description, and existing body intact.
3. After all needed writes succeed, run `reference-index.js rebuild`, then
   `reference-index.js move-old`. The latter moves the original aggregates
   intact into timestamped files in `reference/legacy/` without overwriting
   files. If it returns `EXISTS`, report the conflict and leave the originals
   in place. The procedure does not write decision pages or archived sources.

If interrupted, leave the old files in place. The next system instruction starts
at step 1 and checks which facts already appear on current pages. Resolve an
append conflict or retry a lock timeout before moving the old files.
