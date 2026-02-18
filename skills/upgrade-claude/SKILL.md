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

Determine who to notify:
- **If actively collaborating with a user:** Send the summary to that user's channel via C4 (their `reply via` path). This keeps the user informed AND records the context into C4 conversation history.
- **If no active user conversation:** Send the summary to the web console channel. This still records it into C4 so the new session's startup hook (c4-session-init) will include it in the conversation context.

The goal is twofold: (a) the user knows what's happening, and (b) the handoff summary appears in C4 conversation history, so the new session can seamlessly continue the work.

### 5. Launch the upgrade script

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/zylos/.claude/skills/upgrade-claude/scripts/upgrade.js >> ~/zylos/logs/upgrade.log 2>&1 &
```

## How It Works

1. **Enqueue /exit**: Puts `/exit` into the control queue (priority=1, require_idle) — dispatcher handles idle detection and message blocking
2. **Wait for exit**: Monitors Claude process until it exits (up to 120s); aborts if timeout
3. **Upgrade**: Runs native installer (`curl -fsSL https://claude.ai/install.sh | bash`)
4. **Daemon restart**: activity-monitor detects exit and restarts Claude automatically
