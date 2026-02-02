---
name: web-console
description: Built-in web interface for communicating with Claude. Core C4 channel.
---

# Web Console (C4 Built-in Channel)

Default communication channel - works without any external service.

## Purpose

Allows users to communicate with Claude even without Telegram/Lark/Discord.
This is the baseline, always-available interface.

## Access

URL: `https://<your-domain>/console/`

Served by Caddy (C6 HTTP Layer).

## Features

- Send messages to Claude
- View conversation history
- Real-time status indicator
- Mobile-friendly interface

## Architecture

```
Browser ──► Web Console ──► C4 Bridge ──► Claude
                              │
                              ▼
                           SQLite
```

## Integration with C4

Web Console uses standard C4 interface:
- Calls `c4-receive.sh --source web` to send messages
- Receives replies via WebSocket or polling

## Files

```
~/.claude/skills/web-console/
├── SKILL.md
├── index.html
├── app.js
└── api/
    └── handler.js
```

## Status

**TODO**: Implementation pending. Currently a placeholder.
