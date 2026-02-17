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

Enqueue `/exit` as a high-priority control message:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/exit" --priority 1 --require-idle
```

## How It Works

1. **Enqueue /exit**: Puts `/exit` into the control queue (priority=1, require_idle)
2. **Block subsequent messages**: require_idle prevents other messages from being dispatched
3. **Deliver when idle**: Dispatcher delivers `/exit` to tmux when Claude is idle
4. **Daemon restart**: activity-monitor detects exit and restarts Claude