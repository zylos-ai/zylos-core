# c4-control.js — Control Queue Interface

System control plane for heartbeat probes, maintenance commands, and other out-of-band instructions that bypass the normal conversation queue.

Control messages are stored in the `control_queue` table in `~/zylos/comm-bridge/c4.db`.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js <enqueue|get|ack> [options]
```

## Subcommands

### enqueue

Insert a new control message into the queue.

```bash
c4-control.js enqueue --content "<text>" [--priority 0] [--require-idle] [--bypass-state] [--ack-deadline <seconds>] [--available-in <seconds>]
```

| Option | Description |
|--------|-------------|
| `--content <text>` | Instruction content (required) |
| `--priority <n>` | Priority level (see Priority Levels below, default: 0) |
| `--require-idle` | Only deliver when Claude is idle |
| `--bypass-state` | Deliver regardless of current state |
| `--ack-deadline <seconds>` | Seconds from now until the control times out if unacknowledged |
| `--available-in <seconds>` | Delay before the control becomes eligible for delivery |

**Output:**

```
OK: enqueued control 42
```

### get

Retrieve the current status of a control record.

```bash
c4-control.js get --id <control_id>
```

**Output:**

```
status=pending
```

Possible status values: `pending`, `running`, `done`, `failed`, `timeout`.

### ack

Acknowledge a control message, marking it as done. Idempotent for records already in a final state.

```bash
c4-control.js ack --id <control_id>
```

**Output:**

```
OK: control 42 marked as done
```

If already in a final state:

```
OK: control 42 already in final state (done)
```

## Priority Levels

Control queue priorities mirror the conversation queue, with an additional level 0 for liveness-critical messages.

| Priority | Level | Description | Example |
|----------|-------|-------------|---------|
| 0 | Critical | Liveness probes that must run before anything else | Heartbeat |
| 1 | Urgent | Time-sensitive system operations | — |
| 2 | High | Important but not time-critical | — |
| 3 | Normal | Routine periodic checks (default for most control messages) | Health check |

Lower number = higher priority. The dispatcher consumes control messages in `ORDER BY priority ASC, created_at ASC`.

**Note:** Conversation queue uses priorities 1–3 (urgent/high/normal). Control priority 0 has no conversation equivalent — it exists specifically for heartbeat probes that must bypass even urgent conversations.

## `__CONTROL_ID__` Placeholder

If the `--content` value contains the literal string `__CONTROL_ID__`, it is replaced with the actual control id after insertion. This allows self-referencing messages:

```bash
c4-control.js enqueue --content "Heartbeat check. Ack with: c4-control.js ack --id __CONTROL_ID__" --ack-deadline 120
```

The stored content will read `... ack --id 42` (where 42 is the assigned id).

## Status Lifecycle

```
pending ──► running ──► done
                   └──► failed
pending ──► timeout  (ack deadline exceeded)
```

- `pending`: Queued, waiting for delivery
- `running`: Delivered, awaiting ack
- `done`: Acknowledged successfully
- `failed`: Delivery or processing failed
- `timeout`: Ack deadline exceeded without acknowledgement

## Examples

```bash
# Heartbeat probe with 2-minute ack deadline
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js \
    enqueue --content "Heartbeat. Ack: c4-control.js ack --id __CONTROL_ID__" \
    --ack-deadline 120

# Check status of control 5
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js get --id 5

# Acknowledge control 5
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js ack --id 5

# Delayed maintenance command (available in 60s, idle-only)
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js \
    enqueue --content "Run log rotation" \
    --require-idle --available-in 60
```
