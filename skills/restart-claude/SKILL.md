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

Send the full handoff summary to the internal web console channel via C4:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "web-console" "session-handoff"
<handoff summary>
EOF
```

This records the handoff in C4 conversation history so the restarted session's
startup hook (`c4-session-init`) can include it in startup context.

Do not send the full handoff summary to the active external user channel
(Telegram, Lark, Feishu, HXA, etc.). Handoff summaries are operational context
for the next agent session and may contain task state from outside the current
conversation. If the user is actively waiting, send only a short user-facing
notice to their current `reply via` path, without internal task inventory or
cross-channel context.

### 5. Enqueue /exit

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/exit" --priority 1 --block-queue-until-idle
```

## How It Works

1. **Enqueue /exit**: Puts `/exit` into the control queue (priority=1, block_queue_until_idle)
2. **Block subsequent messages**: block_queue_until_idle prevents other messages from being dispatched
3. **Deliver when idle**: Dispatcher delivers `/exit` to tmux when Claude is idle
4. **Daemon restart**: activity-monitor detects exit and restarts Claude
