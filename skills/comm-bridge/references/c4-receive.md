# c4-receive.js — Receive Interface

Receives messages from external channels and queues them for delivery to Claude.

Messages are written to DB with `status='pending'`. The c4-dispatcher daemon handles serial delivery to Claude via tmux.

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
| `--no-reply` | Omit `reply via` suffix; defaults channel to `system` |
| `--require-idle` | Only deliver when Claude is idle |
| `--json` | Output structured JSON instead of plain text |

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
    --channel scheduler --require-idle \
    --content 'Run daily report'

# Lark topic (endpoint with multiple parts)
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel lark --endpoint "chat_xxx topic_yyy" \
    --content '[Lark] user said: hello'
```

## Large Message Handling

Messages exceeding the configured size threshold are stored as files under `~/zylos/comm-bridge/attachments/`. The DB record contains a preview of the content plus the file path.

## Health Gating

Before queuing a message, `c4-receive.js` reads the `health` field from `~/zylos/activity-monitor/claude-status.json`. If health is not `ok`:

1. The channel/endpoint is recorded in `~/zylos/comm-bridge/pending-channels.jsonl` for recovery notification
2. The message is rejected with a structured error:
   - `HEALTH_RECOVERING` — automatic recovery in progress
   - `HEALTH_DOWN` — manual intervention required

## JSON Output

When `--json` is passed, all output uses structured JSON on stdout.

**Success:**

```json
{"ok": true, "action": "queued", "id": 42}
```

**Error:**

```json
{"ok": false, "error": {"code": "HEALTH_RECOVERING", "message": "System is recovering, please wait."}}
```

Error codes: `INVALID_ARGS`, `HEALTH_RECOVERING`, `HEALTH_DOWN`, `INTERNAL_ERROR`.

## Fail-Open Behavior

If the status file is missing, unreadable, or contains malformed JSON, health defaults to `ok` and the message passes through normally. This ensures a broken status file never blocks message intake.

## Reply Protocol

Unless `--no-reply` is set, the message content is appended with a `reply via` suffix so Claude knows how to respond:

```
[TG DM] user said: hello ---- reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "8101553026"
```
