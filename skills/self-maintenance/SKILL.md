---
name: self-maintenance
description: Monitor Claude health, auto-restart on crash, handle upgrades, track context. Core C2 component.
---

# Self-Maintenance (C2)

Monitors Claude's running state and ensures continuous operation.

## Components

- **activity-monitor.js**: Guardian daemon that monitors Claude and auto-restarts on crash
- **restart-claude.js**: Graceful restart with memory save
- **upgrade-claude.js**: Upgrade Claude Code to latest version
- **check-context.js**: Accurately check context/token usage via /context command

## When to Use

- System automatically runs activity-monitor via PM2
- Use restart-claude.js when Claude needs a fresh start
- Use upgrade-claude.js when new Claude Code version available
- Use check-context.sh to monitor context before it gets too high

## Activity Monitor States

```
OFFLINE → STOPPED → BUSY ↔ IDLE
```

- **OFFLINE**: tmux session not found
- **STOPPED**: tmux exists but Claude not running
- **BUSY**: Claude active (recent activity)
- **IDLE**: Claude idle (no recent activity)

## Status File

`~/.claude-status` contains current state as JSON:
```json
{
  "state": "idle",
  "last_activity": 1706745590,
  "idle_seconds": 30
}
```

## Commands

```bash
# Check status
cat ~/.claude-status | jq

# Manual restart
node ~/.claude/skills/self-maintenance/restart-claude.js

# Upgrade Claude Code
node ~/.claude/skills/self-maintenance/upgrade-claude.js
```

## Service Management

```bash
pm2 status activity-monitor
pm2 logs activity-monitor
pm2 restart activity-monitor
```

## Context Monitoring

Check current context/token usage accurately using the /context command.

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/.claude/skills/self-maintenance/check-context.js > /dev/null 2>&1 &
```

The script:
1. Waits for Claude to be idle
2. Sends /context command via tmux
3. Output appears in conversation
4. Prompts Claude to report status

### Context Thresholds

| Level | Usage | Action |
|-------|-------|--------|
| Normal | <70% | Continue working |
| Warning | 70-80% | Save memory soon |
| High | 80-85% | Save memory, prepare for compact/restart |
| Critical | >85% | Compact or restart immediately |
