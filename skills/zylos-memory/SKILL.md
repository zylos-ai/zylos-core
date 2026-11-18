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
current work, following the runtime-specific result handling below. For a
pre-reclaim request, wait for its result before acknowledging that control as
instructed.

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
  only the files listed for that job under Worker procedures. Include their paths, the requested job,
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

Pass the exact restricted tool name, inherited bindings, selected procedure's installed absolute path, and relevant facts absent from C4/inbox (code findings, unmentioned actions and pitfalls). Capture these as they arise with memory-append.js rather than waiting for Sync. The worker cannot see the parent conversation.

Select the job named in the control prompt, then check the inherited environment:

- `group Sync` with a nonempty `ZYLOS_SESSION_GROUP` uses kind=group and
  `zylos-group-sync`, including in `origin`: it syncs origin's own working state.
- Only a prompt naming `Origin Sync` selects kind=origin and `zylos-origin-sync`;
  this job can run only in the `origin` group.
- `group Sync` with no group and a `ZYLOS_RUN_ID` uses single global Sync
  (kind=global, `zylos-global-sync`).
- If the prompt does not name a job (an old prompt queued before an upgrade,
  or a user's manual request to sync memory), use group Sync when a group is
  bound and global Sync when no group is bound; never infer Origin Sync.

Never infer Origin Sync merely from being in origin. Never invent or replace these bindings. The parent reads only this skill; the worker reads only the files listed under Worker procedures for its selected procedure: [group](references/group-sync.md), [Origin](references/origin-sync.md), or [global](references/global-sync.md), with the exact common-file list below. Pass these installed absolute paths in the worker task. Old queued prompts saying "Read the zylos-memory skill" use this same dispatch and result handling.

## Parent result handling

These rules apply to group, Origin, and global Sync; the parent owns owner notification.

- Claude: continue current work without waiting for an ordinary background
  Sync. Handle its completion notification and report failure to the owner.
- Codex: continue useful current work after launching, but **before ending the parent turn**, use native agent wait/result tools to read this worker's terminal result. A timeout or an empty wait is not a terminal result; wait again while keeping the input channel responsive. If the worker no longer exists, has been closed, or its result can no longer be retrieved, stop waiting and treat it as a result that cannot be retrieved. `Completed` describes worker execution, not successful Sync: inspect checkpoint, state commit and release outcomes. Idle notifications may not trigger another turn; retrieve the result now.
- Only the worker's final result decides whether Sync succeeded or failed.
  Messages the worker sends while it is still running are not a Sync outcome;
  do not report success or failure from them.
- Report a failed Sync to the owner once, before finishing the parent turn in
  Codex. Send directly only to addresses your own thread handles; to reach any
  other owner address, send an internal message to the owning thread asking it
  to deliver the report (One thread per address). Include partial commits and
  cleanup/release warnings; do not repeat a report already sent for this run.
  If the result cannot be retrieved, report that failure without claiming Sync
  succeeded. Successful Sync and the documented `SYNC_BUSY` no-op need no extra
  owner message. Do not restart Sync to obtain a successful result.

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

## Worker procedures

Pass only these installed files to the worker; read them completely before taking a token:

- Group: [group-sync.md](references/group-sync.md), [sync-common.md](references/sync-common.md), [state-format.md](references/state-format.md).
- Origin: [origin-sync.md](references/origin-sync.md), [sync-common.md](references/sync-common.md), [sync-writing.md](references/sync-writing.md).
- Global: [global-sync.md](references/global-sync.md), [sync-common.md](references/sync-common.md), [sync-writing.md](references/sync-writing.md), [state-format.md](references/state-format.md).

Do not send sync-writing.md to group workers. [Common rules](references/sync-common.md) cover full byte reads and failures; [writing and content](references/sync-writing.md) covers restricted edits and shared-knowledge classification. The parent does not read these worker files to launch Sync.

Component memory writers use the [memory-write API](references/memory-write.md). For unmatched legacy topics, follow [old-file lookup](references/sync-writing.md#moving-from-old-files).
