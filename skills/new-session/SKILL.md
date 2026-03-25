---
name: new-session
description: Start a new session when context is high. Both Claude and Codex use /clear. Use when context is high or when a fresh session is needed.
---

# New Session Skill

Start a fresh session with graceful handoff.
Claude and Codex both use `/clear` (process stays alive, only context resets).

## When to Use

- Context usage exceeds the runtime threshold (triggered automatically by context monitoring)
- User explicitly asks for a new session or context reset
- When you need a clean context but don't need to reload settings/hooks (use restart-claude for that)

## Pre-Clear Checklist

Before sending the session switch command, complete these steps **in order**:

### 1. Inventory running background tasks

Check for running background agents using `TaskList`. **Do NOT stop them** — background subagents survive /clear and will continue running to completion in the new session.

For each running task, note:
- **Agent ID** (e.g., `a42c1aabc5b984e69`)
- **What it's doing** (brief description)
- **Output file path** (so the new session can check on it)

This information goes into the handoff summary (step 3).

### 2. Sync memory

Launch a background subagent for memory sync using the **Task tool** (`subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`). The subagent's prompt must instruct it to follow the full sync flow in `~/zylos/.claude/skills/zylos-memory/SKILL.md`. Wait for it to complete before proceeding.

### 3. Write a session handoff summary

Write a brief message covering:
- **What was being worked on** (active tasks, user requests in progress)
- **Current state** (what's done, what's pending, any blockers)
- **Running background tasks** (from step 1 — include agent IDs and output file paths so the new session can use `TaskOutput` or `Read` to check on them)
- **What the next session should pick up** (if anything)

### 4. Send the handoff summary

Determine who to notify:
- **If actively collaborating with a user:** Send the summary to that user's channel via C4 (their `reply via` path). This keeps the user informed AND records the context into C4 conversation history.
- **If no active user conversation:** Send the summary to the web console channel. This still records it into C4 so the new session's startup hook (c4-session-init) will include it in the conversation context.

The goal is twofold: (a) the user knows what's happening, and (b) the handoff summary appears in C4 conversation history, so the new session can seamlessly continue the work.

### 5. Enqueue Session Switch Command

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/clear" --priority 1 --require-idle
```

## How It Works

1. **Enqueue switch command**: Puts `/clear` into the control queue
2. **Deliver when idle**: Dispatcher delivers the command when idle
3. **Session switches**:
   - Claude: clears conversation context, session-start hooks fire
   - Codex: clears conversation context and continues in the same runtime process
4. **Background tasks survive**: Any running subagents continue as independent processes
5. **New session**: The new session picks up handoff context (including background task IDs) from C4 conversation history via session-start hooks, and can use `TaskOutput` to receive results from still-running tasks
