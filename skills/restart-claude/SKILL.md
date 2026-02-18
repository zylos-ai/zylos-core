---
name: restart-claude
description: Use when the user asks to restart Claude Code, or after changing settings/hooks/keybindings.
---

# Restart Claude Code Skill

Restart Claude Code session - sends /exit and lets activity-monitor daemon handle the restart.

## When to Use

- After changing Claude Code settings, hooks, or keybindings
- When Claude needs to reload configuration
- To clear temporary state without upgrading
- User explicitly asks to restart

## Pre-Restart Checklist

Before sending `/exit`, complete these steps **in order**:

### 1. Stop background tasks

Check for running background agents (Task tool). If any are active, stop them to avoid orphaned work.

### 2. Sync memory

Update memory files (state.md, sessions/current.md, etc.) to preserve important context that would otherwise be lost on restart.

### 3. Write a session handoff summary

Write a brief message covering:
- **What was being worked on** (active tasks, user requests in progress)
- **Current state** (what's done, what's pending, any blockers)
- **What the next session should pick up** (if anything)

### 4. Send the handoff summary

Determine who to notify:
- **If actively collaborating with a user:** Send the summary to that user's channel via C4 (their `reply via` path). This keeps the user informed AND records the context into C4 conversation history.
- **If no active user conversation:** Send the summary to the web console channel. This still records it into C4 so the new session's startup hook (c4-session-init) will include it in the conversation context.

The goal is twofold: (a) the user knows what's happening, and (b) the handoff summary appears in C4 conversation history, so the new session can seamlessly continue the work.

### 5. Enqueue /exit

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/exit" --priority 1 --require-idle
```

## How It Works

1. **Enqueue /exit**: Puts `/exit` into the control queue (priority=1, require_idle)
2. **Block subsequent messages**: require_idle prevents other messages from being dispatched
3. **Deliver when idle**: Dispatcher delivers `/exit` to tmux when Claude is idle
4. **Daemon restart**: activity-monitor detects exit and restarts Claude
