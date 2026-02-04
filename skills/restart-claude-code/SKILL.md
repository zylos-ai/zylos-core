---
name: restart-claude-code
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

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/.claude/skills/restart-claude-code/restart.js > /dev/null 2>&1 &
```

After running this command:
1. Wait for you to become idle (idle_seconds >= 5)
2. Send `/exit` command via C4
3. activity-monitor daemon detects exit and restarts Claude automatically

## How It Works

1. **Idle detection**: Waits for idle state (idle_seconds >= 5)
2. **Send /exit**: Uses C4 Communication Bridge (priority=1, --no-reply)
3. **Daemon restart**: activity-monitor detects exit and restarts Claude
