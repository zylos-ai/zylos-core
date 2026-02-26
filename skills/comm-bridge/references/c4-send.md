# c4-send.js — Send Interface

Sends messages from Claude to external channels. Records the outgoing message in DB, then delegates to the channel's `send.js` script.

## Usage

**Always use stdin mode (recommended)**. Passing messages as CLI arguments is fragile — shell escaping silently truncates messages containing quotes, `$`, backticks, or other special characters.

```bash
# Recommended: stdin mode (safe for any content)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> <endpoint_id>
message with "quotes", $vars, `backticks` — all safe
EOF

# Legacy: CLI argument (only for trivial messages with no special chars)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> <endpoint_id> "simple message"
```

### How stdin mode works

1. When no message argument is provided and stdin is piped (`process.stdin.isTTY === false`), c4-send.js reads the message from stdin automatically.
2. The message bypasses shell argument parsing entirely — heredoc content is raw bytes.
3. After reading, c4-send.js passes the message to the channel script via `spawn()` arguments as before. **Channels need no changes.**

### Flags

| Flag | Effect |
|------|--------|
| (none) | Auto-detect: stdin if piped, CLI argument otherwise |
| `--stdin` | Force stdin mode even if a message argument is also present |

## Examples

```bash
# Telegram — stdin mode
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
Hello! This message has "quotes" and $100 safely.
EOF

# Lark group thread — stdin mode (multi-part endpoint)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js lark "chat_xxx|type:group|root:msg_yyy"
Report ready. Contains **markdown** and "special chars".
EOF

# Broadcast (no endpoint) — stdin mode
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram
Hello everyone!
EOF

# Simple message — CLI argument (legacy, only when no special chars)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026 "Hello!"
```

**Note**: Endpoint structure depends on the channel implementation. Some channels use multi-part endpoints with pipe-separated values. Always quote multi-part endpoints as a single argument.

## Channel Interface Contract

Channels are skills installed in `~/zylos/.claude/skills/`. Each channel must provide:

- **Send script**: `~/zylos/.claude/skills/<channel>/scripts/send.js <endpoint_id> <message>`
- **Config**: `~/zylos/<channel>/config.json` (for data like `primary_dm`)

The send script must return exit code 0 on success, non-zero on failure. Stdin mode is transparent to channels — they always receive the message as a CLI argument from c4-send.js's `spawn()` call.
