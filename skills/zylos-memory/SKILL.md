---
name: zylos-memory
description: >-
  Maintain scoped working memory and shared self knowledge. Run group, Origin,
  or single global Memory Sync when requested by the supervisor. Launch through
  the current runtime's background subagent mechanism, not the Skill tool.
disable-model-invocation: true
user-invocable: false
---

# Memory System

Memory Sync is maintenance. Do not perform business tasks, send user replies,
change project code, install components, or restart services during Sync.
The supervisor decides when to request Sync; do not add startup or periodic
triggers here. Start a background subagent when requested and continue the
current work. For a pre-reclaim request, wait for its result before acknowledging
that control as instructed.

## Start the correct background worker

Use the runtime in the current running session's immutable launch snapshot.
If the snapshot cannot be read, use the runtime identity observed from that
session's live process. Do not choose from machine defaults or a newer desired
configuration. Origin Sync uses Origin's actual runtime.

- Claude: launch `zylos-group-sync`, `zylos-origin-sync`, or `zylos-global-sync`
  with `run_in_background: true`; these definitions use `sonnet`. Never use a
  `fork` type or any mechanism that inherits the parent conversation for Sync.
- Codex: use this session's native `spawn_agent` with `fork_turns: "none"`.
  Before launch, inspect the current `spawn_agent` tool's exposed model list.
  If it lists a Terra-tier model, pass that exact ID in `model`; do not omit
  the field and inherit instead. Only if no Terra-tier model is listed, omit
  `model` and record that fallback reason in the worker message. Do not guess
  a model ID or change runtime/model configuration to make one available.
  Do not pass `reasoning_effort`. In the Sync result, distinguish the requested
  model (or inheritance) from the actual model verified by runtime evidence;
  if the actual model cannot be verified, report it as unverified.
  Give the worker a self-contained message instructing it to read
  this skill and the matching procedure. Include their paths, the requested job,
  and all facts and environment bindings it needs; it cannot see the parent
  conversation.
- Never use a new `codex exec`, PM2 service, or detached shell as a substitute.
  If background tools or the restricted memory tool are unavailable, report
  `TOOL_UNAVAILABLE` and stop; do not silently run an unrestricted writer.

Before launch, the parent discovers the exposed restricted memory tool and
passes its exact name in the worker message. Claude normally exposes
`mcp__zylos-memory__edit_memory`; Codex normally exposes
`mcp__zylos_memory__edit_memory`. If that name is absent, discover an exposed
tool ending in `edit_memory` before declaring `TOOL_UNAVAILABLE`. Never select
an unrestricted writer as a substitute.

For both runtimes, the parent must include a few lines in the worker's task
message covering relevant facts from this period that are absent from the
conversation: findings from code or logs, actions it took without mentioning
them, and pitfalls it encountered. The worker reads C4 and inbox, but cannot see
the parent conversation. Record these facts as they arise with
`memory-append.js inbox --kind fact`, `--kind decision`, or `--kind commitment`,
rather than waiting until Sync to capture them.

Select by the requested job and inherited environment: a nonempty
`ZYLOS_SESSION_GROUP` means group Sync; only the `origin` group can run Origin
Sync. No group with a `ZYLOS_RUN_ID` means single global Sync. Never invent or
replace these bindings. Read [the complete Sync procedures](references/sync-procedures.md)
before taking a token; run only the selected procedure.

## Writing rules

All Sync content edits and new memory files use the discovered `edit_memory`
tool passed by the parent.
Origin and global Sync also run the documented `reference-index.js rebuild`,
`archive`, and `unarchive` commands to maintain generated indexes and page locations.
Read inputs with Read (offset/limit), Glob, or read-only Bash commands
`grep -n`, `rg -n`, `sed -n '<a>,<b>p'`, and bounded `dd` byte reads; use Grep
when available.
For exported batches and listed inputs, read every byte in bounded ranges and
verify the reported byte count and SHA-256 using read-only tools. Truncated
output is unread: retry with a smaller limit/range until complete. Do not infer
completion from the first/last lines or a successful hash check alone. Use
returned absolute paths; never synthesize segment or session paths.
Follow the procedure's private export-directory cleanup and per-file byte-range
ledger, including for a single long line. Origin obtains log paths through
read-only `sync-files.js list --group G`, without reading state or segments.
Do not read an entire old file into a script. Memory writes still use only the
documented tools and scripts.
Do not use native Edit/Write/patch, shell redirects into memory, or a fallback
writer after a tool denial. The token is from `sync-lock.js acquire`, never
from another worker. The tool infers permission from its own environment and
the matching marker; a model-supplied group or role is not authorization.

Group Sync writes only its temporary state and its guarded checkpoint/commit.
Origin Sync writes shared self files; it does not read or write group state or
inbox. Global Sync writes global temporary state and shared self files, and
never reads `session-groups/`. Formal state replacement, input cleanup, and
progress changes use the guarded scripts. Never call `c4-checkpoint.js create`
or a raw origin cursor mutation.

Sync does not write `ZYLOS.md`, group `rules.md`, `handoff.md`, or custom startup
instructions. Do not copy rule text into state/inbox or clear a handoff because
its conversations are covered by a checkpoint.

## Ordinary running-thread memory

Record a commitment, decision, or learned fact immediately using
`memory-append.js inbox --kind commitment|decision|fact`, one body line via stdin.
Record work history using `memory-append.js session`, which chooses the dated
session file using configured TZ. Do not create `sessions/current.md`.
Do not directly edit state; Sync consolidates inbox into it.

An explicit user request to edit shared self knowledge may be fulfilled by the
running thread's normal Edit tool. This exception does not authorize Sync to
bypass its restricted tool. After an actual identity change, request rotation
with `request-rotation.js --reason identity` and report any rejection. Direct
thread editing does not share Sync's lock, so do not claim all writers are
mutually protected. Cross-group requests are sent through the normal internal
channel; do not write another group's files.

External file editors can use the [locked memory writer](references/memory-write.md)
to save an existing file with a content hash and refuse an active Sync. This
does not replace the restricted Sync tool or authorize additional Sync writes.

## Content and formats

Keep only current focus, active work, pending items, and commitments in state.
There is no state length budget. Never summarize away or drop pending absorbed
messages to make the file smaller; commit preserves their exact remaining lines.
Use the state header and four sections in [state format](references/state-format.md).
Use [inbox format](references/inbox-format.md) and [session log format](references/session-log-format.md)
for ordinary append operations.

Shared knowledge classification:

- `identity.md`: stable identity, principles, and durable behavior; avoid incident histories.
- `references.md`: essential identity, boundaries, and navigation. Reuse topic files,
  maintain content/path/read-when pointers, and keep a single source of truth.
- `reference/decisions/`: an INDEX plus one page per decision topic, for committed choices and rationale.
- `reference/projects/`: an INDEX plus one page per scoped project, for work and status.
- Old `reference/projects.md`, `reference/decisions.md`, and `reference/legacy/` are read-only history. Start with the category INDEX, then Grep pages (including `archive/`), then consult old files or `legacy/` only when needed; see [Sync procedures](references/sync-procedures.md).
- `reference/preferences.md`: standing shared preferences.
- `reference/ideas.md`: uncommitted proposals.
- `users/<id>/profile.md`: individual preferences and stable facts.

Read an existing target before generating its replacement fragment. Check
references for duplicated configuration values or narrative history; move the
information into an allowed topic file and replace it with a pointer. The shared
identity/references budget is 16 KiB, with references audited at 8 KiB.
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
