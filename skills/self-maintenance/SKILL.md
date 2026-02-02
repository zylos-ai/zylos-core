---
name: self-maintenance
description: Monitor Claude health, auto-restart on crash, handle upgrades. Core C2 component.
---

# Self-Maintenance (C2)

Monitors Claude's running state and ensures continuous operation.

## Components

- **activity-monitor.sh**: Guardian daemon that monitors Claude and auto-restarts on crash
- **restart-claude.sh**: Graceful restart with memory save
- **upgrade-claude.sh**: Upgrade Claude Code to latest version

## When to Use

- System automatically runs activity-monitor via PM2
- Use restart-claude.sh when Claude needs a fresh start
- Use upgrade-claude.sh when new Claude Code version available

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
~/.claude/skills/self-maintenance/restart-claude.sh

# Upgrade Claude Code
~/.claude/skills/self-maintenance/upgrade-claude.sh
```

## Service Management

```bash
pm2 status activity-monitor
pm2 logs activity-monitor
pm2 restart activity-monitor
```
