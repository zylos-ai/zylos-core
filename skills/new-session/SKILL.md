---
name: new-session
description: Start a new session when context is high. Claude uses /clear, Codex uses /exit. Use when context is high or when a fresh session is needed.
---

# New Session Skill

Start a fresh session with graceful handoff.
Use runtime-specific switch commands:
- Claude: `/clear`
- Codex: `/exit`

## When to Use

- Context usage exceeds the runtime threshold (triggered automatically by context monitoring)
- User explicitly asks for a new session or context reset
- When you need a clean context but don't need to reload settings/hooks (use restart-claude for that)

## Pre-Switch Checklist

Before sending the session switch command, complete these steps **in order**:

### 1. Inventory running background tasks

Check for running background agents using the current runtime's available agent/task listing capability. For Claude, this is `TaskList`.

Runtime behavior differs here:
- **Claude**: ordinary background subagents can survive `/clear`.
- **Codex**: `/exit` terminates background tasks. Before enqueueing `/exit`, make sure required background work has finished.

For configuration reclaim, both runtimes must first wait for necessary background
work. Do not acknowledge ready while it is still running.

For each running task, note:
- **Agent ID** (e.g., `a42c1aabc5b984e69`)
- **What it's doing** (brief description)
- **Output file path** (so the new session can check on it)

This information goes into the handoff summary (step 2).

### 2. Read and merge the current scope's handoff

Use the W4 handoff path supplied by Bootstrap: multi uses
`memory/session-groups/$ZYLOS_SESSION_GROUP/handoff.md`; single uses
`memory/handoff.md`. Do not accept another group's or run's selector.
Read the existing file completely, using successive ranges for long files.
An absent file means there is no prior handoff. An unreadable or incomplete file
is a failure: report it, recover the full read, and do not submit exit or ready.
Check real progress and history, then retain every unfinished or unverified item.
Reading never clears the file; Memory Sync must never clear it. Clear it only
when all its work has completed or been cancelled.

Write a brief message covering:
- **What was being worked on** (active tasks, user requests in progress)
- **Current state** (what's done, what's pending, any blockers)
- **Running background tasks** (from step 1 — include agent/task IDs and any output file paths or result handles so the new session can check on them with the runtime-appropriate output mechanism)
- **What the next session should pick up** (if anything)

Preserve absorbed-message run ID, total/per-scope counts, first/last IDs, full
query and reply commands, and unfinished follow-up pointers. Keep detailed reports
in their files. The next session must follow the system template's paginated
absorbed-message verification flow before repeating work or replying.
For repeated mode switches, check the referenced switch archive against the
actual run before reusing a fixed-path recovery file. Report ambiguous references
and retain the unresolved item rather than assuming that recovery succeeded.

### 3. Atomically replace W4

Write the merged handoff into a unique temporary file in W4's directory, then
rename it over W4. Only successful rename permits rotation. A write or rename
failure preserves the old W4: report failure and keep working without submitting
exit or ready. Do not send handoff text to `void` or an external channel.

If the user is waiting, send only a short notice via their exact `reply via` path,
without cross-channel task inventory.

### 4. Enqueue Session Switch Command

For ordinary rotation use the actual running runtime, not the F1 default. Multi
must add `--group "$ZYLOS_SESSION_GROUP"`; single omits it. For Codex:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/exit" --priority 1 --block-queue-until-idle --no-ack-suffix
```

For Claude:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/clear" --priority 1 --block-queue-until-idle --no-ack-suffix
```

If enqueue is rejected, report failure and retain W4; do not loop or assume the
session will rotate.

### Configuration Reclaim

After W4 succeeds and required background work finishes, call the supervisor's
`ready-for-config-reclaim` entry using only your environment's group/run identity
(IB-41). On accepted/already_accepted, finish the turn and let the supervisor
reclaim; do not also enqueue exit/clear. On unchanged continue working with W4
retained. On rejection or no connection report it and retain W4. If sent but the
reply is uncertain, retry the same (G,R) idempotently or read the request record;
do not add a separate exit.

## How It Works

1. **Memory Sync** follows its own schedule; rotation and Bootstrap do not force it.
2. **Pre-switch checks**: Inventory background tasks, read and atomically merge W4.
3. **Enqueue switch command**: Puts the runtime-specific command into the control queue (`/clear` for Claude, `/exit` for Codex)
4. **Deliver when idle**: Dispatcher delivers the command when idle
5. **Session switches**:
   - Claude: `/clear` resets conversation context, session-start hooks fire, and background subagents continue independently
   - Codex: `/exit` exits the current session so a fresh one can start
6. **New session**: Bootstrap supplies W4 and working-memory paths. READY permits
   delivery; it does not prove the handoff has been read or followed up.
