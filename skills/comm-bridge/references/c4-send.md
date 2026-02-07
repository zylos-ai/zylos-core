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
~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026 "Hello!"
~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js lark "chat_id topic_id" "Report ready"
```

## Channel Interface Contract

Channels are skills installed in `~/zylos/.claude/skills/`. Each channel must provide:

- **Send script**: `~/zylos/.claude/skills/<channel>/scripts/send.js <endpoint_id> <message>`
- **Config**: `~/zylos/<channel>/config.json` (for data like `primary_dm`)

The send script must return exit code 0 on success, non-zero on failure.
