---
name: restart-claude-code
description: Use when the user asks to restart Claude Code, or after changing settings/hooks/keybindings.
---

# Restart Claude Code Skill

Restart Claude Code session without upgrading - sends /exit and lets activity-monitor daemon handle the restart.

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
1. Script requests you to sync memory (update context.md)
2. Wait for you to become idle (idle_seconds >= 3)
3. Send `/exit` command via C4
4. activity-monitor daemon detects exit and restarts Claude automatically
5. New Claude session starts in ~10 seconds

## How It Works

1. **Memory sync request**: Asks you to update context.md before restart
2. **Idle detection**: Waits for idle state (ensures memory sync completes)
3. **Send /exit**: Uses C4 Communication Bridge (priority=1, --no-reply)
4. **Daemon restart**: activity-monitor detects exit and restarts Claude
