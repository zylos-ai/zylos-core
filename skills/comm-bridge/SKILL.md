---
name: comm-bridge
description: >-
  C4 communication bridge — central gateway for ALL external communication (Telegram, Lark, etc.).
  Use when replying to users via the "reply via" path, sending proactive messages to external channels,
  fetching conversation history for Memory Sync, or creating checkpoints after sync.
  Incoming messages are queued by channel bots and delivered to Claude via a PM2 dispatcher daemon.
  Session-start and user-message hooks automatically provide conversation context and trigger Memory Sync when unsummarized conversations exceed the configured threshold.
---

# Communication Bridge (C4)

Central message hub - ALL communication with Claude goes through C4.

## Architecture

```
Web Console ──┐
Telegram    ───┼──► C4 Bridge ◄──► Claude
Lark        ───┘
```

## Components

| Script | Purpose | Reference |
|--------|---------|-----------|
| `c4-receive.js` | External → Claude (queue incoming messages) | [c4-receive](references/c4-receive.md) |
| `c4-send.js` | Claude → External (route outgoing messages) | [c4-send](references/c4-send.md) |
| `c4-dispatcher.js` | PM2 daemon: polls pending queue, delivers to tmux | — |
| `c4-session-init.js` | Hook (session start): context + Memory Sync trigger | [hooks](references/hooks.md) |
| `c4-threshold-check.js` | Hook (user message): Memory Sync trigger | [hooks](references/hooks.md) |
| `c4-fetch.js` | Fetch conversations by id range | [c4-fetch](references/c4-fetch.md) |
| `c4-checkpoint.js` | Create checkpoint after Memory Sync | [c4-checkpoint](references/c4-checkpoint.md) |

## Database

SQLite at `~/zylos/comm-bridge/c4.db`:
- `conversations`: All messages (in/out) with priority, status, retry tracking
- `checkpoints`: Recovery points with conversation id ranges

## Service Management

```bash
pm2 status c4-dispatcher
pm2 logs c4-dispatcher
pm2 restart c4-dispatcher
```
