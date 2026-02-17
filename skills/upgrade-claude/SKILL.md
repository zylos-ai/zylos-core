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

## How to Use

**Best Practice:** Before upgrading, it's recommended to sync memory (update memory files) to preserve important context.

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/zylos/.claude/skills/upgrade-claude/scripts/upgrade.js >> ~/zylos/logs/upgrade.log 2>&1 &
```

## How It Works

1. **Enqueue /exit**: Puts `/exit` into the control queue (priority=1, require_idle) — dispatcher handles idle detection and message blocking
2. **Wait for exit**: Monitors Claude process until it exits (up to 120s); aborts if timeout
3. **Upgrade**: Runs native installer (`curl -fsSL https://claude.ai/install.sh | bash`)
4. **Daemon restart**: activity-monitor detects exit and restarts Claude automatically
