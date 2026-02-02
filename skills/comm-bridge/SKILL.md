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
| `c4-receive.sh` | External → Claude (records + forwards) |
| `c4-send.sh` | Claude → External (records + routes) |
| `c4-checkpoint.sh` | Create recovery checkpoint |
| `c4-recover.sh` | Get conversations since last checkpoint |
| `c4-notify.sh` | Broadcast notification to all channels |

## Message Flow

**Receiving** (external → Claude):
```bash
~/.claude/skills/comm-bridge/c4-receive.sh \
    --source telegram \
    --endpoint 12345 \
    --content '[TG] user said: hello'
```

**Sending** (Claude → external):
```bash
~/.claude/skills/comm-bridge/c4-send.sh telegram 12345 "Hello!"
```

**Notify** (broadcast):
```bash
~/.claude/skills/comm-bridge/c4-notify.sh "System alert: low disk space"
```

## Database

SQLite at `~/zylos/comm-bridge/c4.db`:
- `conversations`: All messages (in/out)
- `checkpoints`: Recovery points

## Channel Interface

Channels must provide: `~/zylos/channels/<name>/send.sh <endpoint_id> <message>`

Returns 0 on success, non-zero on failure.

## Reply Protocol

Messages to Claude include routing info:
```
[TG DM] user said: hello ---- reply via: ~/.claude/skills/comm-bridge/c4-send.sh telegram 12345
```

Claude uses the `reply via` path to respond.
