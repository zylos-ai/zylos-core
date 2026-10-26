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
  with `run_in_background: true`; these definitions use `sonnet`.
- Codex: use this session's native `spawn_agent` mechanism, ask the worker to
  read this skill and the matching procedure, and use a Codex-supported worker
  model. Do not map the Claude model name or force the parent model/effort.
- Never use a new `codex exec`, PM2 service, or detached shell as a substitute.
  If background tools or the restricted memory tool are unavailable, report
  `TOOL_UNAVAILABLE` and stop; do not silently run an unrestricted writer.

Select by the requested job and inherited environment: a nonempty
`ZYLOS_SESSION_GROUP` means group Sync; only the `origin` group can run Origin
Sync. No group with a `ZYLOS_RUN_ID` means single global Sync. Never invent or
replace these bindings. Read [the complete Sync procedures](references/sync-procedures.md)
before taking a token; run only the selected procedure.

## Writing rules

All Sync edits and new memory files use `mcp__zylos-memory__edit_memory`.
Use Read/Glob/Grep for inputs and Bash only for the documented scripts.
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
- `reference/decisions.md`: committed choices and rationale.
- `reference/projects.md`: scoped work and status.
- `reference/preferences.md`: standing shared preferences.
- `reference/ideas.md`: uncommitted proposals.
- `users/<id>/profile.md`: individual preferences and stable facts.

Read an existing target before generating its replacement fragment. Check
references for duplicated configuration values or narrative history; move the
information into an allowed topic file and replace it with a pointer. The shared
identity/references budget is 16 KiB, with references audited at 8 KiB. Other
reference files have no size cap. Do not copy whole startup instructions into
memory. References layout migration belongs to its dedicated migration command,
not an improvised Sync write.

`memory-status.js` and `consolidate.js` are read-only diagnostics; they do not
replace Sync or its progress commits. `daily-commit.js` is an independent local
Git backup. `rotate-session.js` is only a one-time legacy-log migration during
upgrade; it is not a Sync step. Existing format/example files in `references/`
and `examples/` document each shared knowledge category.
