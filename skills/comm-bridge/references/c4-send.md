# c4-send.js — Send Interface

Sends agent messages to external channels. Commits the outgoing audit row before delegating to the channel's `send.js` script.

## Usage

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> <endpoint_id>
Your message here. Quotes, $vars, `backticks` — all safe.
EOF
```

Messages are piped via stdin using a heredoc. This bypasses shell argument parsing entirely, so any content (quotes, variables, markdown) is delivered verbatim.

### Important safety rule

- The heredoc terminator line (for example `EOF`) is shell wrapper syntax, not part of the message body.
- Do not include the terminator token itself as a standalone line inside the message content.
- When generating a send command, treat the wrapper as fixed boilerplate and only substitute `<channel>`, `<endpoint_id>`, and the message body.

### How it works

1. When stdin is piped, c4-send.js reads the full message from stdin.
2. The heredoc content is raw bytes — no shell escaping needed.
3. c4-send.js passes the message to the channel's `send.js` script via `spawn()`.

## Examples

```bash
# Send to Telegram DM
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
Hello! This message has "quotes" and $100 safely.
EOF

# Send to Lark group thread (multi-part endpoint)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js lark "chat_xxx|type:group|root:msg_yyy"
Report ready. Contains **markdown** and "special chars".
EOF

# Broadcast to all subscribers (no endpoint)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram --stdin
Hello everyone!
EOF
```

If the message body itself may contain a line like `EOF`, use a different terminator token for the wrapper, for example:

```bash
cat <<'C4MSG' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
This message can mention EOF safely.
C4MSG
```

**Note**: Endpoint structure depends on the channel implementation. Some channels use multi-part endpoints with pipe-separated values. Always quote multi-part endpoints as a single argument.

## Session Groups

An explicit group name goes last, after the channel and optional endpoint:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026 --stdin --session-group team
Report ready.
EOF
```

Without `--session-group`, the audit row uses the latest inbound group for the
same channel and endpoint, or the channel's overall group when no history exists.
An unknown or invalid explicit group falls back to the channel's overall group
and records an `out_group_fallback` diagnostic. The endpoint passed to the
component stays unchanged. `--group` is not accepted. Use stdin when literal
content contains reserved option tokens.

## Absorbed Replies

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js --absorbed-reply <runId> <id>
Reply content.
EOF
```

This reads the absorbed message's original route from the database. Supply the
transition UUID and positive decimal message id; do not copy the endpoint from
message text. The message must still belong to that transition's absorbed set.
Internal routes delegate to the internal handler.

## Internal Messages

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js internal telegram:team
Please check the current status.
EOF
```

The sender comes from `ZYLOS_SESSION_GROUP`; the target is a full existing group.
Content is stdin-only. Extra arguments, `--session-group`, and `--group` are
rejected. A successful command reports that the message was queued.

## Failures

Empty content and missing component scripts are rejected before writing an audit.
Endpoints containing NUL or more than 131071 UTF-8 bytes return
`ENDPOINT_NOT_PASSABLE` before audit or dispatch. Component spawn failures retain
the audit and return `COMPONENT_SPAWN_FAILED`; a nonzero component exit returns
`SEND_FAILED`, with external delivery unconfirmed. The command does not retry.

## The `void` Channel (internal-only messages)

`void` is a virtual channel for internal memos (e.g. session handoffs). Messages sent to it are recorded in c4.db like any other conversation row — so session-start context injection and Memory Sync pick them up — but they are **never dispatched** to any channel send script, and display surfaces (web console, etc.) never show them. The endpoint carries the purpose/topic and is **mandatory**:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "void" "session-handoff"
Handoff summary for the next session...
EOF
```

The recording session must provide `ZYLOS_SESSION_GROUP`, or `ZYLOS_RUN_ID` for
Origin. The group must exist. `void` does not accept `--session-group`.

## Channel Interface Contract

Channels are skills installed in `~/zylos/.claude/skills/`. Each channel must provide:

- **Send script**: `~/zylos/.claude/skills/<channel>/scripts/send.js <endpoint_id> <message>`
- **Config**: `~/zylos/<channel>/config.json` (for data like `primary_dm`)

The send script must return exit code 0 on success, non-zero on failure.
