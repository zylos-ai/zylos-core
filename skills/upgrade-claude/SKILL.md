---
name: upgrade-claude
description: Upgrade Claude Code to the latest version with graceful shutdown and auto-restart. Use when the user asks to upgrade or when a new Claude Code version is available.
---

# Upgrade Claude Code Skill

Upgrade Claude Code to the latest version - sends /exit, waits for exit, upgrades, and lets activity-monitor restart.

## When to Use

- User explicitly asks to upgrade Claude Code
- New Claude Code version is available
- Need to apply Claude Code updates

## Pre-Upgrade Checklist

Before launching the upgrade script, complete these steps **in order**:

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

Send the full handoff summary to the internal `void` channel via C4:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "void" "session-handoff"
<handoff summary>
EOF
```

The `void` channel is record-only: the message is stored in C4 conversation
history (so the upgraded session's startup hook, `c4-session-init`, includes
it in startup context) but is never delivered to any real channel or display
surface.

Do not send the full handoff summary to the active external user channel
(Telegram, Lark, Feishu, HXA, etc.). Handoff summaries are operational context
for the next agent session and may contain task state from outside the current
conversation. If the user is actively waiting, send only a short user-facing
notice to their current `reply via` path, without internal task inventory or
cross-channel context.

### 5. Launch the upgrade script

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/zylos/.claude/skills/upgrade-claude/scripts/upgrade.js >> ~/zylos/logs/upgrade.log 2>&1 &
```

## How It Works

1. **Enqueue /exit**: Puts `/exit` into the control queue (priority=1, block_queue_until_idle) — dispatcher handles idle detection and message blocking
2. **Wait for exit**: Monitors Claude process until it exits (up to 120s); aborts if timeout
3. **Upgrade**: Runs native installer (`curl -fsSL https://claude.ai/install.sh | bash`)
4. **Daemon restart**: activity-monitor detects exit and restarts Claude automatically
