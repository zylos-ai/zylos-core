# c4-receive.js — Receive Interface

Receives messages from external channels and queues them for delivery to Claude.

Accepted work is written with `status='pending'`. Rejected work is recorded with `status='failed'`; a status reply does not deliver that work to the runtime.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel <channel> [options] --content "<message>"
```

## Options

| Option | Description |
|--------|-------------|
| `--channel <name>` | Channel name (required unless `--no-reply`) |
| `--endpoint <id>` | Endpoint identifier. Can contain multiple space-separated parts (e.g., `"chat_id topic_id"` for Lark topics) |
| `--content <text>` | Message content (required) |
| `--priority <1-3>` | Priority level (default: 3) |
| `--no-reply` | Mark the message as having no reply target; defaults channel to `system` |
| `--block-queue-until-idle` | Wait for sustained idle, then block later dispatch until execution settles |
| `--json` | Output structured JSON instead of plain text |
| `--session-group <name>` | Component-local group name; validated before routing or database writes |
| `--core-source scheduler` | Mark a scheduler-originated call; other values are rejected |

## Priority Levels

| Priority | Type | Description |
|----------|------|-------------|
| 1 | Urgent | System alerts, immediate execution |
| 2 | High | Important user messages |
| 3 | Normal | Default priority |

## Examples

```bash
# Standard user message from Telegram
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel telegram --endpoint 8101553026 \
    --content '[TG DM] user said: hello'

# System message (no reply routing)
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel system --priority 1 --no-reply \
    --content '[System] Check context usage'

# Idle-only delivery
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel scheduler --block-queue-until-idle \
    --content 'Run daily report'

# Lark topic (endpoint with multiple parts)
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel lark --endpoint "chat_xxx topic_yyy" \
    --content '[Lark] user said: hello'
```

## Message Storage

Inbound content is stored in the conversations DB exactly as received. `c4-receive.js` does not append reply-routing text and does not replace large messages with attachment previews.

## Health Routing

Before committing a message, `c4-receive.js` sends a v2 route request. An explicit pending decision takes precedence over health labels, including rate limiting and recovery waits. Authentication rejection writes a failed row with the permanent category `auth_rejected`. Other unrecovered routes also write failed rows. Replies, when enabled, use a cooldown scoped by channel, normalized endpoint, committed group, runtime, health and reason. A CLI action of `delivered` describes the status reply, not delivery of the inbound work to the runtime.

If IPC is unavailable or returns an invalid response, the entry resolves the target runtime and reads only its runtime-health record. An active mode transition, unknown runtime, missing/unreadable health record, or healthy/rate-limited runtime leaves the work pending. Authentication failure rejects external input; scheduler-originated input remains pending. The whole-agent status projection is not a routing source.

## JSON Output

When `--json` is passed, all output uses structured JSON on stdout.

**Success:**

```json
{"ok": true, "action": "queued", "id": 42, "sessionGroup": "telegram", "runtime": "claude"}
```

**Error:**

```json
{"ok": false, "error": {"code": "INVALID_ARGS", "message": "--content is required", "persisted": []}}
```

Errors include `INVALID_ARGS`, group validation codes, `DB_BUSY`, `INTERNAL_ERROR`, `UNHEALTHY_NOTIFY_FAILED` and `UNHEALTHY_NOTIFY_UNCERTAIN`. A postcommit notice error retains the inbound row and reports `persisted:["D1"]` with its id. An unknown commit state uses `persisted:null`. Do not automatically retry an uncertain or already committed inbound call.

## Fail-Open Behavior

Missing or unreadable target health evidence leaves work pending without inventing a healthy observation.

## Authentication Rejection Lookup

`node c4-db.js rejection --id <id> [--json]` reads the permanent row category and retained entry-event logs. It returns the historical reason when present, or `expired_or_missing` when the log is absent. Log write failure reports `reasonLogged:false` on the inbound result and does not undo the failed row. A missing historical reason is not permission to resend.

## Reply Protocol

When a queued message is delivered to the agent, c4-dispatcher adds a `reply via` suffix for inbound messages that have an endpoint. Session startup context uses the same agent-facing formatting. Stored DB content and `c4-fetch` output remain clean:

```
[TG DM] user said: hello ---- reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "8101553026"
```
