# Sync writing and content rules

## Writing rules

All Sync content edits and new memory files use the discovered `edit_memory`
tool passed by the parent.
Origin and global Sync also run the documented `reference-index.js rebuild`,
`archive`, and `unarchive` commands to maintain generated indexes and page locations.
Read inputs with Read (offset/limit), Glob, or read-only Bash commands
`grep -n`, `rg -n`, `sed -n '<a>,<b>p'`, and bounded `dd` byte reads; use Grep
when available.
For exported batches and listed inputs, read every byte in bounded ranges.
Use reported byte counts only as byte-range read endpoints. Truncated
output is unread: use the procedure's bounded retries, one range per top-level
call; do not batch ranges into a single return. Do not infer
completion from the first/last lines or a successful hash check alone. Use
returned absolute paths; never synthesize export, segment or session paths.
Follow the procedure's private export-directory cleanup and per-file byte-range
ledger, including for a single long line. Follow the procedure's Complete
byte-range reads steps. For every exported file and every listed input, run
`tail -c 64 "<returned absolute path>" | od -An -v -c` after the full text read
so trailing whitespace is visible in only a few lines.
Remove only this run's private export directory with
`rm -r "<absolute path of this run's private directory>"`; do not add `-f`.
Origin obtains log paths through read-only `sync-files.js list --group G`,
without reading state or segments.
Origin exports both of its reads with `--out` and advances cursors only by
passing the unchanged receipts and list result to `origin-cursor.js advance`.
Do not read an entire old file into a script. Memory writes still use only the
documented tools and scripts.
Do not use native Edit/Write/patch, shell redirects into memory, or a fallback
writer after a tool denial. The token is from `sync-lock.js acquire`, never
from another worker. The tool infers permission from its own environment and
the matching marker; a model-supplied group or role is not authorization.

Group and global Sync first read the entire state, in all bounded byte ranges.
Guarded `sync-files.js prepare` chooses the mode from actual bytes: above 20480,
`mode:"rewrite"` makes no copy and the worker creates a compact complete state;
at or below budget, `mode:"edit"` copies the state for unique-fragment edits.
A missing state returns STATE_MISSING and needs a complete initial document.
Use `edit_memory` for either mode. Group Sync writes only its temporary state and
its guarded checkpoint/commit.
Origin Sync writes shared self files; it does not read or write group state or
inbox. Global Sync writes global temporary state and shared self files, and
never reads `session-groups/`. Formal state replacement, input cleanup, and
progress changes use the guarded scripts. Never call `c4-checkpoint.js create`
or a raw origin cursor mutation.

Sync does not write `ZYLOS.md`, group `rules.md`, `handoff.md`, or custom startup
instructions. Do not copy rule text into state/inbox or clear a handoff because
its conversations are covered by a checkpoint.

## Content and formats

Keep only current focus, active work, pending items, and commitments in state.
Target the 20 KiB soft state budget (STATE_BUDGET_BYTES in sync-files.js).
Remove completed and superseded entries this round, including old ones found
in the mandatory full state read. Rewrite mode compacts the whole document;
edit mode changes only necessary fragments. Update a changed status in its
original entry, never append a conflicting second status for the same work.
Before removing each completed or superseded item, include one result line in
this round’s checkpoint summary. In group Sync, Origin Sync records that result
on its project page; group Sync never writes shared reference files. In single
global Sync, write the result to its project page yourself before checkpoint. Commit reports published bytes
and an over-budget flag without blocking publication. Never summarize away or drop pending absorbed
messages to make the file smaller; commit preserves their exact remaining lines.
Use the state header and four sections in [state format](state-format.md).
Use [inbox format](inbox-format.md) and [session log format](session-log-format.md)
for ordinary append operations.

Shared knowledge classification:

- `identity.md`: stable identity, principles, and durable behavior; avoid incident histories.
- `references.md`: essential identity, boundaries, and navigation. Reuse topic files,
  maintain content/path/read-when pointers, and keep a single source of truth.
- `reference/decisions/`: an INDEX plus one page per decision topic, for committed choices and rationale.
- `reference/projects/`: an INDEX plus one page per scoped project, for work and status.
- Old `reference/projects.md`, `reference/decisions.md`, and `reference/legacy/` are read-only history. Start with the category INDEX, then Grep pages (including `archive/`), then consult old files or `legacy/` only when needed; see [Sync procedures](sync-procedures.md).
- `reference/preferences.md`: standing shared preferences.
- `reference/ideas.md`: uncommitted proposals.
- `users/<id>/profile.md`: individual preferences and stable facts.

Read an existing target before generating its replacement fragment. Check
references for duplicated configuration values or narrative history; move the
information into an allowed topic file and replace it with a pointer. `identity.md`
and `references.md` each have the same startup display limits across all runtimes:
check both characters and estimated tokens after reserving the worst-case startup
framing. Agents: run
`node ~/zylos/.claude/skills/zylos-memory/scripts/memory-status.js` after editing
these files and during the shared-file Sync audit; include their `WARN` or `OVER`
results in the Sync report. Components: call `measureMemoryText(file, candidateText)`
through the [candidate-text budget API](memory-budget.md) before a write.
Do not copy its estimator or limits. At 80% of either dimension, audit the file on
the next Memory Sync. Do not send extra owner/system alerts or block writes.
`reference/projects/INDEX.md` and `reference/decisions/INDEX.md` each have a
16 KiB warning threshold and 32 KiB budget. These indexes are optional until
created: `memory-status.js` prints `not created yet` without a missing-file
health issue. Other reference files, including the read-only old files, have
no size budget. Budget reporting does not block writes. Do not copy whole
startup instructions into memory. References layout migration belongs to its dedicated migration command,
not an improvised Sync write.

`memory-status.js` and `consolidate.js` are read-only diagnostics; they do not
replace Sync or its progress commits. `daily-commit.js` is an independent local
Git backup; files over 50 MB are left out of it and listed in its output. `rotate-session.js` is only a one-time legacy-log migration during
upgrade; it is not a Sync step. Existing format/example files in `references/`
and `examples/` document each shared knowledge category.

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
