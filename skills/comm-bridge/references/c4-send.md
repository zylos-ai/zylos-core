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

Core asks `<skillsDir>/<channel>/scripts/session-group.js <endpoint>` which
group handles the address before BeforeSend, recording or delivery. The script
runs through Node argv without a shell, with closed stdin, component cwd and the
send environment. Queries run for every send, without caching, under a five-second
timeout and 4 KiB stdout limit. Core removes only one final LF/CRLF; empty output,
a missing script or NULL endpoint means the overall namespace. Nonempty output
must match the group-name grammar and 95-character limit. Failure, timeout,
oversized output or invalid output refuses with `SESSION_GROUP_QUERY_FAILED`,
without hooks, messages, sends or a fallback. The fixed `dashboard origin`
address belongs to `origin` for both directions and never queries the script.

Core compares this one result with inherited `ZYLOS_SESSION_GROUP` when the key
exists. Empty or unknown sender values fail `UNKNOWN_GROUP`; `origin` is checked
like any group. Different groups fail `CROSS_SESSION_OUTBOUND`, even for a first
message to a new recipient or a group not yet in history. The error supplies the
responsible group and an internal command with destination/text/reason placeholders;
it does not echo the endpoint. Ask the owning thread to deliver the message and
judge the request; never change your environment to bypass the check. A missing
namespace binding may be created for this command, but no message is recorded.

Without the sender key, the comparison is skipped and the message is still
queried and recorded under the component's answer. A `ZYLOS_RUN_ID` alone does
not activate the check. Message history never chooses ownership. The answer is
used once for checking, hook options and recording; the transaction does not
recheck. Legacy trailing `--session-group NAME` is silently accepted and discarded,
while malformed placement still fails `INVALID_ARGS`. Generated reply-via omits
it. `--group` is not accepted. Use stdin for literal option tokens in content.

System notification callers and Core PM2 service startup
paths clear both session variables from the invoking environment, including
`zylos start`, init, ecosystem restarts, component registration and upgrade
recovery. PM2 `--update-env` merges values into each service's saved environment;
omitting keys does not remove them from an already contaminated service record.
Such records require `pm2 delete <name>` followed by a fresh start to clear the
saved session identity. This is a per-service record limitation, not leakage
from the PM2 daemon's own environment. No automatic record deletion is added.
OpenMax's direct `comm.send`/`comm.ask` bypass C4 and are outside this guard.

## Absorbed Replies

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js --absorbed-reply <runId> <id>
Reply content.
EOF
```

This reads the absorbed message's original route from the database. Supply the
transition UUID and positive decimal message id; do not copy the endpoint from
message text. The message must still belong to that transition's absorbed set.
Internal routes delegate to the internal handler. External absorbed replies use
the same component query and sender check as ordinary sends, rather than the
absorbed row's old group. If refused, relay the reply text and exact absorbed
command to the responsible group; do not reconstruct its endpoint.

## Internal Messages

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js internal telegram:team
Please check the current status.
EOF
```

The sender comes from `ZYLOS_SESSION_GROUP`; the target is a full group. A target
may be new if its namespace belongs to an installed component; sending creates
its message/head so its thread can start. Unknown or uninstalled namespaces fail.
Content is stdin-only. Extra arguments, `--session-group`, and `--group` are
rejected. A successful command reports that the message was queued.

## Failures

Empty content and missing component scripts are rejected before writing an audit.
Endpoints containing NUL or more than 131071 UTF-8 bytes return
`ENDPOINT_NOT_PASSABLE` before audit or dispatch. Component spawn failures retain
the audit and return `COMPONENT_SPAWN_FAILED`; a nonzero component exit returns
`SEND_FAILED`, with external delivery unconfirmed. The command does not retry.

## The `void` Channel (internal-only messages)

`void` is a virtual channel for internal memos (e.g. session handoffs). Messages sent to it are recorded in c4.db like any other conversation row — so session-start context injection and Memory Sync pick them up — but they are **never dispatched** to any channel send script, and display surfaces (Dashboard, etc.) never show them. The endpoint carries the purpose/topic and is **mandatory**:

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
- **Optional group query**: `scripts/session-group.js <endpoint_id>` returns the
  same group name that the component uses for inbound messages. It must be a
  regular file and follow the bounded query protocol above; no query means the
  whole component namespace. Dashboard's query refuses `origin`, which Core
  handles through the shared fixed-address rule.
- **Config**: `~/zylos/<channel>/config.json` (for data like `primary_dm`)

The send script must return exit code 0 on success, non-zero on failure.
