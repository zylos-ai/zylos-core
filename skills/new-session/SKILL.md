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
- **Claude**: background subagents survive `/clear`, so do not stop them.
- **Codex**: `/exit` terminates background tasks. Before enqueueing `/exit`, make sure required background work has finished, especially memory sync.

For each running task, note:
- **Agent ID** (e.g., `a42c1aabc5b984e69`)
- **What it's doing** (brief description)
- **Output file path** (so the new session can check on it)

This information goes into the handoff summary (step 3).

### 2. Memory sync (runtime-dependent)

Memory sync is normally triggered **earlier** by the context monitor — at 80% of the session-switch threshold — so it should already be running (or finished) by the time this skill fires.

- **Claude**: Memory sync is **not** required here. Background subagents survive `/clear`, so any in-progress sync will continue in the new session. If you notice memory sync was NOT already triggered (e.g., the session switch was user-requested rather than threshold-triggered), launch it as a background task but **do not wait** for it to complete — proceed immediately to step 3.

- **Codex**: `/exit` kills background tasks, so memory sync **must** complete before enqueueing `/exit`. Launch a background subagent for memory sync using the current session's available background-agent capability with a Codex-supported model (do not hardcode `sonnet`). The subagent's prompt must instruct it to follow the full sync flow in `~/zylos/.claude/skills/zylos-memory/SKILL.md`. Wait for completion before proceeding.

### 3. Write a session handoff summary

Write a brief message covering:
- **What was being worked on** (active tasks, user requests in progress)
- **Current state** (what's done, what's pending, any blockers)
- **Running background tasks** (from step 1 — include agent/task IDs and any output file paths or result handles so the new session can check on them with the runtime-appropriate output mechanism)
- **What the next session should pick up** (if anything)

### 4. Send the handoff summary

Determine who to notify:
- **If actively collaborating with a user:** Send the summary to that user's channel via C4 (their `reply via` path). This keeps the user informed AND records the context into C4 conversation history.
- **If no active user conversation:** Send the summary to the web console channel. This still records it into C4 so the new session's startup hook (c4-session-init) will include it in the conversation context.

The goal is twofold: (a) the user knows what's happening, and (b) the handoff summary appears in C4 conversation history, so the new session can seamlessly continue the work.

### 5. Enqueue Session Switch Command

For Codex:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/exit" --priority 1 --require-idle --no-ack-suffix
```

For Claude:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/clear" --priority 1 --require-idle --no-ack-suffix
```

## How It Works

1. **Early memory sync** (handled by context-monitor, not this skill): At 80% of the session-switch threshold, the context monitor injects a prompt for Claude to run memory sync in the background. This gives sync ample time to finish before the session switch fires.
2. **Pre-switch checks**: Inventory background tasks, write handoff summary. For Codex only, ensure memory sync has completed (since `/exit` kills background tasks).
3. **Enqueue switch command**: Puts the runtime-specific command into the control queue (`/clear` for Claude, `/exit` for Codex)
4. **Deliver when idle**: Dispatcher delivers the command when idle
5. **Session switches**:
   - Claude: `/clear` resets conversation context, session-start hooks fire, and background subagents (including any in-progress memory sync) continue independently
   - Codex: `/exit` exits the current session so a fresh one can start, and background tasks from that session do not survive
6. **New session**:
   - Claude: the new session can continue alongside surviving background tasks
   - Codex: the new session relies on the completed handoff state recorded before `/exit`
