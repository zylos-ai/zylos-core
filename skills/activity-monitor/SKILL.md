---
name: activity-monitor
description: Guardian service that monitors Claude's state and automatically restarts it if stopped.
user-invocable: false
---

# Activity Monitor Skill

PM2 guardian service that monitors Claude Code's activity state and ensures it's always running.

## When to Use

This is a **PM2 service** (not directly invoked by Claude). It runs continuously in the background.

## What It Does

1. **Activity Monitoring**: Tracks Claude's busy/idle state every second
2. **Status File**: Writes `~/.claude-status` with current state (busy/idle, idle_seconds)
3. **Guardian Mode**: Automatically restarts Claude if it stops or crashes
4. **Maintenance Awareness**: Waits for restart/upgrade scripts to complete before starting Claude

## Status File Format

```json
{
  "state": "idle",
  "last_activity": 1738675200,
  "last_check": 1738675210,
  "last_check_human": "2026-02-04 20:30:10",
  "idle_seconds": 5,
  "inactive_seconds": 10,
  "source": "conv_file"
}
```

- `state`: "busy" | "idle" | "stopped" | "offline"
- `idle_seconds`: Time since entering idle state (0 when busy)
- `source`: "conv_file" (reliable) | "tmux_activity" (fallback)

## PM2 Management

```bash
# Start
pm2 start ~/zylos/.claude/skills/activity-monitor/scripts/activity-monitor.js --name activity-monitor

# Restart
pm2 restart activity-monitor

# View logs
pm2 logs activity-monitor

# Check status
pm2 list
```

## Guardian Behavior

- **Detection**: Checks if Claude is running every second
- **Restart Delay**: Waits 5 seconds of continuous "not running" before restarting
- **Maintenance Wait**: Detects restart/upgrade scripts and waits for completion
- **Recovery Prompt**: Sends catch-up message via C4 after restart

## How It Works

1. **Monitor Loop** (every 1s):
   - Check if tmux session exists
   - Check if Claude process is running
   - Detect activity from conversation file modification time
   - Calculate idle/busy state
   - Write status to ~/.claude-status

2. **Guardian Logic**:
   - If Claude not running for 5+ seconds → restart
   - Wait for maintenance scripts to complete
   - Send recovery prompt via C4 after successful restart

3. **Activity Detection**:
   - Primary: Conversation file modification time (reliable)
   - Fallback: tmux window activity
   - Threshold: 3 seconds without activity = idle

## Log File

Activity log: `~/zylos/activity-monitor/activity.log`
- Auto-truncates to 500 lines daily
- Logs state changes and guardian actions
