# c4-send.js — Send Interface

Sends messages from Claude to external channels. Records the outgoing message in DB, then delegates to the channel's `send.js` script.

## Usage

```bash
# With endpoint
~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> <endpoint_id> "<message>"

# Without endpoint (broadcast)
~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> "<message>"
```

## Examples

```bash
# Telegram (single-part endpoint)
~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026 "Hello!"

# Lark topic (multi-part endpoint, quote as one argument)
~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js lark "chat_xxx topic_yyy" "Report ready"

# Broadcast (no endpoint)
~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram "Hello everyone!"
```

**Note**: Endpoint structure depends on the channel implementation. Some channels use multi-part endpoints with space-separated values (e.g., Lark's `"chat_id topic_id"`). Always quote multi-part endpoints as a single argument.

## Channel Interface Contract

Channels are skills installed in `~/zylos/.claude/skills/`. Each channel must provide:

- **Send script**: `~/zylos/.claude/skills/<channel>/scripts/send.js <endpoint_id> <message>`
- **Config**: `~/zylos/<channel>/config.json` (for data like `primary_dm`)

The send script must return exit code 0 on success, non-zero on failure.
