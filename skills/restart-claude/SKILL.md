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

## How to Use

**Best Practice:** Before restarting, it's recommended to sync memory (update memory files) to preserve important context.

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/.claude/skills/restart-claude/restart.js > /dev/null 2>&1 &
```

## How It Works

1. **Idle detection**: Waits for idle state (idle_seconds >= 3)
2. **Send /exit**: Uses C4 Communication Bridge (priority=1, --no-reply)
3. **Daemon restart**: activity-monitor detects exit and restarts Claude
