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
c4-control.js enqueue --content "<text>" [--priority 3] [--block-queue-until-idle] [--bypass-state] [--ack-deadline <seconds>] [--available-in <seconds>] [--no-ack-suffix] [--group G] [--target-run ID [--expected-runtime RT] [--expected-session ID]] [--json]
```

| Option | Description |
|--------|-------------|
| `--content <text>` | Instruction content (required) |
| `--priority <n>` | Priority level (see Priority Levels below, default: 3 = normal) |
| `--block-queue-until-idle` | Wait for sustained idle, then block later dispatch until execution settles |
| `--bypass-state` | Deliver regardless of current state |
| `--ack-deadline <seconds>` | Seconds from now until the control times out if unacknowledged |
| `--available-in <seconds>` | Delay before the control becomes eligible for delivery |
| `--group <G>` | Target session group. Required once `session_mode` is set in config.json or during a mode switch; see [Target Session Group](#target-session-group) |
| `--target-run <ID>` | Bind to the observed running run ID; rejected if the target changed or is not ready |
| `--expected-runtime <RT>` | With `--target-run`, require the observed runtime to match (for example `claude` or `codex`) |
| `--expected-session <ID>` | With `--target-run`, also require the observed runtime session ID to match |
| `--json` | Emit a structured enqueue result, including the binding when present |
| `--no-ack-suffix` | Do not append `ack via` suffix; dispatcher marks done right after successful submit |

**Output:**

```
OK: enqueued control 42
```

#### Target Session Group

`--group` names the session that receives the control.

- **When it is required:** whenever `~/zylos/.zylos/config.json` contains `session_mode` (multi mode, or single mode after migration), and while a mode switch is in progress. Omitting it then is rejected with `CONTROL_TARGET_REQUIRED` and nothing is queued. Only an install whose config has no `session_mode` accepts a control without `--group`.
- **Which group:** the session the control relates to, for example the session a user is interrupting or the session of the conversation the notice is about. Use `origin` only for a notice that belongs to no specific session. Pass the full group name, including the component namespace (`openmax:dm-<id>`, `telegram:group-100123:topic-45`, or just `openmax` for the component's overall group); unlike `c4-receive --session-group`, nothing is prefixed for you. In single mode after migration the only target is `origin`.
- **Acknowledgement deadline:** a targeted control that keeps the ack suffix must also pass `--ack-deadline`; otherwise it is rejected with `ACK_DEADLINE_REQUIRED`.
- **Delivery is not guaranteed:** controls are delivered only to a running session. A control for a session group that is not running stays pending until that group next starts, and that start marks it `timeout` (`last_error=SESSION_ENDED`) without delivering it. Origin's own restarts keep its pending controls. Senders must not assume delivery: read the result with `get`, or treat the control as best effort.

A notice that should become part of the agent's conversation history (and so feed Memory Sync) is not a control: send it as an ordinary message with [c4-receive](c4-receive.md). Controls are not read by Memory Sync.

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

By default, when a control message is enqueued, the C4 layer automatically appends an ack instruction to the stored queue content. Conversation reply routing is different: `reply via` is added only when conversation records are formatted for agent delivery.

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
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/clear" --priority 1 --block-queue-until-idle --no-ack-suffix ${ZYLOS_SESSION_GROUP:+--group} ${ZYLOS_SESSION_GROUP:+"$ZYLOS_SESSION_GROUP"} ${ZYLOS_RUN_ID:+--target-run} ${ZYLOS_RUN_ID:+"$ZYLOS_RUN_ID"}
```
