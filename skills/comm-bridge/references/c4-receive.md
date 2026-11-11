# c4-receive.js — Receive Interface

Receives messages from external channels and queues them for delivery to Claude.

Messages are written to DB with `status='pending'`. The c4-dispatcher daemon handles serial delivery to Claude via tmux.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel <channel> [options] --content "<message>"

# Content piped on stdin (any size)
printf '%s' "$message" | ~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel <channel> [options] --content-stdin
```

## Options

| Option | Description |
|--------|-------------|
| `--channel <name>` | Channel name (required unless `--no-reply`) |
| `--endpoint <id>` | Endpoint identifier. Can contain multiple space-separated parts (e.g., `"chat_id topic_id"` for Lark topics) |
| `--content <text>` | Message content (this or `--content-stdin` is required) |
| `--content-stdin` | Read the message content from stdin instead of `--content` |
| `--priority <1-3>` | Priority level (default: 3) |
| `--no-reply` | Mark the message as having no reply target; defaults channel to `system` |
| `--block-queue-until-idle` | Wait for sustained idle, then block later dispatch until execution settles |
| `--require-idle` | Legacy alias for `--block-queue-until-idle` |
| `--json` | Output structured JSON instead of plain text |

`scripts/c4-receive-options.json`, next to the actual `c4-receive.js`, is the argument list used by the receiver itself. Its format is `{ "options": { "--channel": { "takesValue": true }, "--no-reply": { "takesValue": false } } }`; all accepted names, including aliases, are listed. `takesValue` specifies whether the next word is consumed as a value, even when it begins with `--`. A missing, unreadable or malformed manifest is an installation error: the receiver exits with `INTERNAL_ERROR` before queuing a message.

Unknown options are ignored with an `Ignored unknown option: --name` notice on stderr; the next word is also skipped when it does not start with `--`, and option values are never included in the notice.

## Content from stdin

`--content` passes the whole message as one command-line argument, and the operating system limits its size (on Linux, 128 KiB for a single argument). A longer message cannot reach `c4-receive.js` this way: starting the process fails before any message is queued. Channels that forward large payloads (group context, history, reply context) should pipe the body on stdin with `--content-stdin` instead.

- The whole of stdin, up to end of input, is the message content. It is stored exactly as received, so a heredoc's final newline is kept; use `printf '%s'` or write the body without a trailing newline when that matters.
- `--content-stdin` cannot be combined with `--content`, needs piped input (a terminal on stdin is rejected), and empty input is rejected. These errors exit with `INVALID_ARGS` before anything is queued.
- The caller must close stdin after writing the body; `c4-receive.js` waits for end of input.
- A component that must also work with an older comm-bridge can check for `--content-stdin` in `scripts/c4-receive-options.json` and fall back to `--content` when it is not listed.

From Node.js:

```js
import { execFile } from 'node:child_process';

const child = execFile('node', [C4_RECEIVE, '--channel', 'telegram', '--endpoint', chatId, '--json', '--content-stdin'],
  (err, stdout) => { /* parse stdout as JSON */ });
child.stdin.end(content);
```

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

# Large payload piped on stdin
printf '%s' "$formatted_payload" | ~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel telegram --endpoint 8101553026 --json --content-stdin
```

## Message Storage

Inbound content is stored in the conversations DB exactly as received. `c4-receive.js` does not append reply-routing text and does not replace large messages with attachment previews.

## Health Routing

Before queuing a message, `c4-receive.js` asks the activity monitor MessageRouter how the current message should be routed. If health is `ok` or the router reports recovery, the message is queued normally. If health is unavailable, rate limited, or authentication failed, the rejected inbound message is recorded as failed and the current channel receives an immediate status reply when replies are enabled. Cooldown-suppressed and `--no-reply` messages are also recorded as failed. A CLI action of `delivered` describes the status reply, not delivery of the inbound work to the runtime.

If the MessageRouter IPC is unavailable, `c4-receive.js` reads `~/zylos/activity-monitor/agent-status.json` and applies the same fallback behavior. Missing, unreadable, or malformed status files fail open as `ok`.

## JSON Output

When `--json` is passed, all output uses structured JSON on stdout.

**Success:**

```json
{"ok": true, "action": "queued", "id": 42}
```

**Error:**

```json
{"ok": false, "error": {"code": "INVALID_ARGS", "message": "--content is required"}}
```

Error codes: `INVALID_ARGS`, `INTERNAL_ERROR`.

## Fail-Open Behavior

If the status file is missing, unreadable, or contains malformed JSON, health defaults to `ok` and the message passes through normally. This ensures a broken status file never blocks message intake.

## Reply Protocol

When a queued message is delivered to the agent, c4-dispatcher adds a `reply via` suffix for inbound messages that have an endpoint. Session startup context uses the same agent-facing formatting. Stored DB content and `c4-fetch` output remain clean:

```
[TG DM] user said: hello ---- reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "8101553026"
```
