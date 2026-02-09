# Heartbeat Liveness Detection

> Version: 1.0 Draft
> Date: 2026-02-09
> Status: Design Phase

## 1. Problem Statement

Claude may become unresponsive due to:
- Context overflow (too full to process `/compact`)
- Internal error or hang
- Unexpected crash without clean exit

Current activity-monitor (C2) only detects **process-level** failures (Claude process not running). It cannot detect **application-level** hangs where the process is alive but Claude is not responding.

## 2. Design Overview

Add a periodic heartbeat mechanism: the scheduler sends a lightweight command to Claude and expects a response within a timeout. If no response, Claude is considered stuck and recovery is triggered.

### 2.1 Key Insight (Howard)

> "心跳都没响应了，发compact也肯定不会有响应的啦"

If Claude can't respond to a heartbeat, it can't respond to `/compact` either. There is no point in gradual escalation. The only viable action is a **direct restart**.

### 2.2 Design Principles

1. **Simple detection**: Heartbeat sent → response expected → timeout = stuck
2. **Direct recovery**: No gradual escalation. Timeout → restart immediately
3. **C4 graceful degradation**: During outage, C4 handles incoming messages gracefully
4. **Closed-loop UX**: Users are never left wondering what happened

## 3. Heartbeat Mechanism

### 3.1 Flow

```
Scheduler (C5)                    Claude (C1)
    │                                │
    ├── heartbeat task due ──────►   │
    │   (via C4, like any task)      │
    │                                ├── receives heartbeat
    │                                ├── runs: heartbeat-ack.sh
    │                                │   (writes timestamp to file)
    │                                │
    │   ◄── ack file updated ────────┤
    │                                │
    ├── check ack within timeout     │
    │                                │
    ├── OK → reset counter           │
    └── TIMEOUT → trigger recovery   │
```

### 3.2 Heartbeat Task

A recurring scheduled task, dispatched by C5 like any other task:

```
Prompt: "Heartbeat check. Run: ~/.claude/skills/activity-monitor/scripts/heartbeat-ack.sh"
Schedule: Every 5 minutes (configurable)
Priority: 2 (high, but below Howard's messages)
```

### 3.3 Ack Script

`heartbeat-ack.sh` — a minimal script Claude executes to prove liveness:

```bash
#!/bin/bash
# Write current timestamp to ack file
echo '{"ack_at": '$(date +%s)', "status": "alive"}' > ~/.claude-heartbeat-ack
```

### 3.4 Timeout Detection

Activity-monitor (C2) checks the ack file:

```
1. Read ~/.claude-heartbeat-ack
2. Compare ack_at with current time
3. If (now - ack_at) > HEARTBEAT_TIMEOUT → Claude is stuck
```

**Timeout threshold** — must distinguish "busy on a long task" from "truly stuck":
- Heartbeat interval: 5 minutes
- Timeout: 3 missed heartbeats = 15 minutes
- Rationale: Long tasks (research, browser ops) can take 5-10 minutes.
  Missing 3 consecutive heartbeats (15 min) strongly indicates a hang.

> **Note**: The exact timeout threshold is configurable. Howard to finalize.

## 4. C4 Graceful Degradation During Outage

When heartbeat timeout is detected, C4 must handle incoming messages gracefully instead of silently dropping them.

### 4.1 Flow

```
                    Heartbeat timeout detected
                              │
                              ▼
                    C4 enters "degraded" mode
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    Stop accepting      New messages        Trigger
    new messages       with reply channel    recovery
    into queue         get auto-reply:       (restart
                       "系统异常，              Claude)
                        正在尝试恢复"
                              │
                       Record channel
                       in pending list
                              │
                              ▼
                    ┌─────────────────────┐
                    │ Recovery completes  │
                    │ (Claude restarts)   │
                    └─────────┬───────────┘
                              │
                              ▼
                    Notify all recorded
                    channels: "系统已恢复正常"
                              │
                    Clear pending list
                    C4 exits "degraded" mode
```

### 4.2 Key Rules

1. **First heartbeat timeout** → C4 stops accepting new messages into the queue
2. **Messages with reply channel** → C4 directly replies "系统异常，正在尝试恢复" (NOT written to DB — avoids polluting conversation history)
3. **Record channels** → Keep a list of channels that received the error message
4. **Trigger recovery** → Restart Claude (same as current guardian restart)
5. **After recovery** → Send "系统已恢复正常" to all recorded channels, clear list, exit degraded mode

### 4.3 C4 State Machine

```
NORMAL ──(heartbeat timeout)──► DEGRADED
                                    │
                                    ├── auto-reply to incoming
                                    ├── record channels
                                    ├── trigger restart
                                    │
                          (Claude restarts + ack)
                                    │
                                    ▼
                                 NORMAL
                              (notify channels)
```

### 4.4 Implementation Location

- **C4 degraded mode logic**: `skills/comm-bridge/scripts/c4-receive.js`
  - Check a flag file (e.g., `~/zylos/comm-bridge/.degraded`) before accepting messages
  - If degraded: auto-reply → record channel → skip DB write
- **Flag management**: Activity-monitor sets the flag on timeout, clears it after successful restart + ack
- **Channel recording**: Simple JSON file `~/zylos/comm-bridge/.pending-channels.json`

## 5. Recovery Flow

```
Activity-monitor detects heartbeat timeout
    │
    ├── 1. Set C4 degraded flag
    │      echo '{"since": <timestamp>}' > ~/zylos/comm-bridge/.degraded
    │
    ├── 2. Restart Claude (existing guardian logic)
    │      - Kill stuck process if needed
    │      - Start new Claude session
    │      - Send recovery prompt
    │
    ├── 3. Wait for new heartbeat ack
    │      - New session receives heartbeat task
    │      - Claude runs ack script
    │      - Ack file updated with fresh timestamp
    │
    ├── 4. Clear C4 degraded flag
    │      rm ~/zylos/comm-bridge/.degraded
    │
    └── 5. Notify recorded channels
           "系统已恢复正常"
           Clear .pending-channels.json
```

## 6. Configuration

Add to `~/zylos/.env`:

```bash
# Heartbeat configuration
HEARTBEAT_INTERVAL=300      # seconds between heartbeats (default: 5 min)
HEARTBEAT_TIMEOUT=900       # seconds before declaring stuck (default: 15 min)
```

## 7. Relationship to Existing Components

| Component | Role in Heartbeat |
|-----------|-------------------|
| C2 (Activity Monitor) | Checks ack file, detects timeout, triggers recovery, manages degraded flag |
| C4 (Comm Bridge) | Enters/exits degraded mode, auto-replies during outage, records channels |
| C5 (Scheduler) | Dispatches heartbeat task on schedule |
| C1 (Claude) | Executes heartbeat-ack.sh to prove liveness |

## 8. Edge Cases

### 8.1 Long-running tasks

Claude may be legitimately busy for 10+ minutes (e.g., research with agent teams). The 15-minute timeout provides sufficient buffer. If needed, specific long-running skills could update the ack file themselves.

### 8.2 Restart loop

If Claude keeps crashing immediately after restart, the heartbeat will keep failing. The activity-monitor should have a **max restart count** (e.g., 3 attempts within 30 minutes) before alerting the user and stopping.

### 8.3 Scheduler itself hangs

The scheduler is a PM2 process with its own restart policy. If the scheduler hangs, PM2 will restart it. The heartbeat task will resume after scheduler restart.

---

*Document authored by Zylos, based on design discussion with Howard (2026-02-09)*
