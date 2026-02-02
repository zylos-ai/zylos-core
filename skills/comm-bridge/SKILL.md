---
name: comm-bridge
description: Central message gateway for all communication channels. Core C4 component.
---

# Communication Bridge (C4)

Central message hub - ALL communication with Claude goes through C4.

## Architecture

```
Web Console ──┐
Telegram    ───┼──► C4 Bridge ◄──► Claude
Lark        ───┘
```

## Core Functions

| Script | Purpose |
|--------|---------|
| `c4-receive.js` | External → Claude (records + forwards) |
| `c4-send.js` | Claude → External (records + routes) |
| `c4-checkpoint.js` | Create recovery checkpoint |
| `c4-recover.js` | Get conversations since last checkpoint |
| `c4-notify.js` | Broadcast notification to all channels |

## Message Flow

**Receiving** (external → Claude):
```bash
node ~/.claude/skills/comm-bridge/c4-receive.js \
    --source telegram \
    --endpoint 12345 \
    --content '[TG] user said: hello'
```

**Sending** (Claude → external):
```bash
node ~/.claude/skills/comm-bridge/c4-send.js telegram 12345 "Hello!"
```

**Notify** (broadcast):
```bash
node ~/.claude/skills/comm-bridge/c4-notify.js "System alert: low disk space"
```

## Database

SQLite at `~/zylos/comm-bridge/c4.db`:
- `conversations`: All messages (in/out)
- `checkpoints`: Recovery points

## Channel Interface

Channels are skills installed in `~/.claude/skills/`. Each channel must provide:
- `~/.claude/skills/<channel>/send.js <endpoint_id> <message>` (or send.sh for compatibility)
- Config at `~/zylos/<channel>/config.json` (for data like primary_dm)

Returns 0 on success, non-zero on failure.

## Reply Protocol

Messages to Claude include routing info:
```
[TG DM] user said: hello ---- reply via: node ~/.claude/skills/comm-bridge/c4-send.js telegram 12345
```

Claude uses the `reply via` path to respond.
