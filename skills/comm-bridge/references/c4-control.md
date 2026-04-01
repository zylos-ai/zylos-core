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
c4-control.js enqueue --content "<text>" [--priority 3] [--block-queue-until-idle] [--bypass-state] [--ack-deadline <seconds>] [--available-in <seconds>] [--no-ack-suffix]
```

| Option | Description |
|--------|-------------|
| `--content <text>` | Instruction content (required) |
| `--priority <n>` | Priority level (see Priority Levels below, default: 3 = normal) |
| `--block-queue-until-idle` | Wait for sustained idle, then block later dispatch until execution settles |
| `--bypass-state` | Deliver regardless of current state |
| `--ack-deadline <seconds>` | Seconds from now until the control times out if unacknowledged |
| `--available-in <seconds>` | Delay before the control becomes eligible for delivery |
| `--no-ack-suffix` | Do not append `ack via` suffix; dispatcher marks done right after successful submit |

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

Possible status values: `pending`, `running`, `done`, `failed`, `timeout`, `superseded`.

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

## Auto-Appended Ack Suffix

By default, when a control message is enqueued, the C4 layer automatically appends an ack instruction to the content, similar to how `c4-receive` appends `---- reply via:` to conversation messages.

The stored content will include a suffix like:

```
---- ack via: node /path/to/c4-control.js ack --id 42
```

Callers do **not** need to include ack instructions in `--content`. The recipient uses the appended suffix to acknowledge the control after processing.

For slash-style controls that must stay as a clean command (for example `/clear` in Codex), use `--no-ack-suffix`. In that mode, dispatcher marks the control as `done` immediately after successful submit.

## Status Lifecycle

```
pending ──► running ──► done
                   └──► failed
pending ──► timeout  (ack deadline exceeded)
pending ──► superseded  (replaced by a newer equivalent pending control)
```

- `pending`: Queued, waiting for delivery
- `running`: Delivered, awaiting ack
- `done`: Acknowledged successfully
- `failed`: Delivery or processing failed
- `timeout`: Ack deadline exceeded without acknowledgement
- `superseded`: Older equivalent pending control replaced by a newer one; retained for audit only

## Examples

```bash
# Heartbeat probe with 2-minute ack deadline (ack suffix auto-appended)
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js \
    enqueue --content "Heartbeat check." \
    --ack-deadline 120

# Check status of control 5
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js get --id 5

# Acknowledge control 5
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js ack --id 5

# Delayed maintenance command (available in 60s, idle-only)
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js \
    enqueue --content "Run log rotation" \
    --block-queue-until-idle --available-in 60

# Enqueue clean slash command (no ack suffix)
~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js \
    enqueue --content "/clear" \
    --priority 1 --block-queue-until-idle --no-ack-suffix
```
