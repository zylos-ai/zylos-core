---
name: activity-monitor
description: Guardian service that monitors Claude's state and automatically restarts it if stopped. Use when checking Claude's liveness state or understanding the auto-restart mechanism.
user-invocable: false
---

# Activity Monitor Skill

PM2 guardian service that monitors Claude Code's activity state and ensures it's always running.

## When to Use

This is a **PM2 service** (not directly invoked by Claude). It runs continuously in the background.

## What It Does

1. **Activity Monitoring**: Tracks Claude's busy/idle state every second
2. **Status File**: Writes `~/zylos/activity-monitor/claude-status.json` with current state (busy/idle, idle_seconds, health)
3. **Guardian Mode**: Automatically restarts Claude if it stops or crashes
4. **Maintenance Awareness**: Waits for restart/upgrade scripts to complete before starting Claude
5. **Heartbeat Liveness Detection**: Periodically sends heartbeat probes via the C4 control queue to verify Claude is responsive, triggering recovery when probes fail
6. **Health Check**: Periodically enqueues system health checks (PM2, disk, memory) via the C4 control queue
7. **Daily Upgrade**: Enqueues a Claude Code upgrade via the C4 control queue at 5:00 AM local time daily
8. **Context Check**: Hourly context usage check via C4 control queue; triggers restart if usage exceeds 70%

## Status File Format

```json
{
  "state": "idle",
  "last_activity": 1738675200,
  "last_check": 1738675210,
  "last_check_human": "2026-02-04 20:30:10",
  "idle_seconds": 5,
  "inactive_seconds": 10,
  "source": "conv_file",
  "health": "ok"
}
```

- `state`: "busy" | "idle" | "stopped" | "offline"
- `idle_seconds`: Time since entering idle state (0 when busy)
- `source`: "conv_file" (reliable) | "tmux_activity" (fallback)
- `health`: "ok" | "recovering" | "down" — liveness health from the heartbeat engine

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
   - Write status to ~/zylos/activity-monitor/claude-status.json

2. **Guardian Logic**:
   - If Claude not running for 5+ seconds → restart
   - Wait for maintenance scripts to complete
   - Send recovery prompt via C4 after successful restart

3. **Activity Detection**:
   - Primary: Conversation file modification time (reliable)
   - Fallback: tmux window activity
   - Threshold: 3 seconds without activity = idle

## Heartbeat Liveness Detection

The heartbeat engine runs inside the activity monitor and uses the C4 control queue to verify Claude is actually responsive (not just process-alive).

### State Machine

```
          heartbeat interval elapsed
  ┌─────────────────────────────────────┐
  │                                     ▼
  │  ok ──[primary fails]──► ok (verify phase)
  │  ▲                              │
  │  │                     [verify fails]
  │  │                              ▼
  │  │                         recovering ──[recovery fails]──► recovering
  │  │                              │                               │
  │  │                    [ack received]              [max failures reached]
  │  │                              │                               │
  │  └──────────────────────────────┘                               ▼
  │                                                               down
  │                                                                 │
  │                                          [ack received after manual fix]
  └─────────────────────────────────────────────────────────────────┘
```

### Phases

| Phase | Trigger | On Success | On Failure |
|-------|---------|------------|------------|
| **Primary** | Heartbeat interval elapsed (default 30min) | Reset timer, stay `ok` | Enter verify phase |
| **Verify** | Primary probe failed | Return to `ok` | Kill tmux, enter `recovering` |
| **Recovery** | In `recovering` state, Claude restarted | Return to `ok`, notify pending channels | Kill tmux, retry (up to max) |
| **Down** | Max restart failures reached (default 3) | Return to `ok`, notify pending channels | Stay `down`, wait for manual fix |

### Ack Deadline

Each heartbeat probe is enqueued with an ack deadline. If Claude does not acknowledge the probe before the deadline expires, the control record transitions to `timeout` status and the engine treats it as a failure.

### Recovery Behavior

When health transitions back to `ok`, the engine reads `~/zylos/comm-bridge/pending-channels.jsonl` and sends a recovery notification to each recorded channel/endpoint via C4, then clears the file.

## Health Check

The activity monitor periodically enqueues system health checks via the C4 control queue.

- **Interval**: Every 6 hours (21600 seconds)
- **Persisted state**: `~/zylos/activity-monitor/health-check-state.json` (survives restarts)
- **Priority**: 3 (normal)
- **Gated by health**: Only enqueued when `health === 'ok'`
- **Gated by Claude**: Only enqueued when Claude process is running

The health check control message instructs Claude to:
1. Check PM2 services via `pm2 jlist`
2. Check disk space via `df -h`
3. Check memory via `free -m`
4. If issues found, notify the most recent communication channel
5. Log results to `~/zylos/logs/health.log`
6. Acknowledge the control message

## Daily Upgrade

The activity monitor enqueues a daily Claude Code upgrade via the C4 control queue.

- **Schedule**: 5:00 AM local time (configured by `DAILY_UPGRADE_HOUR`)
- **Timezone**: Loaded from `~/zylos/.env` `TZ` field, falls back to `process.env.TZ`, then `UTC`
- **Persisted state**: `~/zylos/activity-monitor/daily-upgrade-state.json` (tracks last upgrade date)
- **Priority**: 3 (normal)
- **Gated by health**: Only enqueued when `health === 'ok'`
- **Gated by Claude**: Only enqueued when Claude process is running
- **Once per day**: Checks local date to avoid duplicate enqueues

The control message instructs Claude to use the `upgrade-claude` skill, which handles idle detection, `/exit`, upgrade, and automatic restart.

## Context Check

Hourly context usage check via the C4 control queue.

- **Interval**: Every 1 hour (3600 seconds)
- **Persisted state**: `~/zylos/activity-monitor/context-check-state.json` (survives restarts)
- **Priority**: 3 (normal)
- **Require idle**: Yes — only delivered when Claude is idle
- **Gated by health**: Only enqueued when `health === 'ok'`
- **Gated by Claude**: Only enqueued when Claude process is running

The control message instructs Claude to:
1. Use the `check-context` skill to get current context usage
2. If usage exceeds 70%, use the `restart-claude` skill to restart

## Daily Memory Commit

The activity monitor runs a daily git commit of the `memory/` directory.

- **Schedule**: 3:00 AM local time
- **Timezone**: Same as daily upgrade (from `~/zylos/.env` TZ)
- **Persisted state**: `~/zylos/activity-monitor/daily-memory-commit-state.json`
- **Script**: Calls `zylos-memory/scripts/daily-commit.js` directly (no C4, no Claude needed)
- **Once per day**: Date-based deduplication
- **Idempotent**: If no memory changes exist, the script skips the commit

## Timing Guarantees

Both daily tasks (upgrade, memory commit) use the same `DailySchedule` class:
- **Window**: Each target hour provides a ~3600s window; with ~1s loop interval it is virtually impossible to miss entirely
- **Dedup**: Date-based (`last_date === today`) ensures exactly-once per day, even with imprecise timing
- **Persistence**: State files survive activity monitor restarts

## Log File

Activity log: `~/zylos/activity-monitor/activity.log`
- Auto-truncates to 500 lines daily
- Logs state changes and guardian actions
