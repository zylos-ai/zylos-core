---
name: upgrade-claude-code
description: Use when the user asks to upgrade Claude Code to the latest version.
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
nohup node ~/.claude/skills/upgrade-claude-code/upgrade.js > /dev/null 2>&1 &
```

## How It Works

1. **Idle detection**: Waits for idle state (idle_seconds >= 3)
2. **Send /exit**: Uses C4 Communication Bridge (priority=1, --no-reply)
3. **Wait for exit**: Monitors Claude process until it exits
4. **Upgrade**: Runs official upgrade script (`curl -fsSL https://claude.ai/install.sh | bash`)
5. **Daemon restart**: activity-monitor detects exit and restarts Claude automatically
