---
name: web-console
description: Built-in web interface for communicating with Claude without external services. Use when setting up or configuring the web console channel, or troubleshooting browser-based access.

lifecycle:
  npm: true
  service:
    type: pm2
    name: web-console
    entry: scripts/server.js
---

# Web Console (C4 Built-in Channel)

Default communication channel - works without any external service.

## Purpose

Allows users to communicate with Claude even without Telegram/Lark/Discord.
This is the baseline, always-available interface.

## Quick Start

```bash
# Install dependencies
cd ~/zylos/.claude/skills/web-console
npm install

# Start server (default port 3456)
node scripts/server.js

# Or with PM2
pm2 start scripts/server.js --name web-console
```

## Access

Local only: `http://127.0.0.1:3456`

Server binds to `127.0.0.1` by default for security.

## Architecture

```
Browser ──► Web Console Server ──► C4 Bridge ──► Claude
                  │
                  ▼
               SQLite (c4.db)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Get Claude's current status |
| `/api/conversations/recent` | GET | Get recent conversation history |
| `/api/upload` | POST | Upload one attachment for the next message |
| `/api/send` | POST | Send message to Claude |
| `/api/media/:messageId` | GET | Download/render an outbound media message |
| `/api/poll?since_id=N` | GET | Poll for new messages |
| `/api/health` | GET | Server health check |

## Files

```
~/zylos/.claude/skills/web-console/
├── SKILL.md
├── package.json
├── scripts/
│   ├── server.js      # Express API server
│   └── send.js        # CLI message sender
└── public/
    ├── index.html     # Chat UI
    ├── styles.css     # Styling
    └── app.js         # Frontend logic
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_CONSOLE_PORT` | 3456 | Server port |
| `ZYLOS_WEB_PASSWORD` | (empty) | Set to enable password protection (also reads `WEB_CONSOLE_PASSWORD` as fallback) |
| `WEB_CONSOLE_BIND` | 127.0.0.1 | Bind address |
| `ZYLOS_DIR` | ~/zylos | Data directory |
| `WEB_CONSOLE_MAX_UPLOAD_MB` | 20 | Max size per uploaded attachment |

## Authentication

By default, no password is required (suitable for local access).

To enable password protection (recommended when exposing externally):
1. Set `ZYLOS_WEB_PASSWORD` in `~/zylos/.env`
2. Restart the web-console service

## Features

- Real-time status indicator (busy/idle/offline)
- Message polling every 2 seconds
- Auto-resizing input
- Browser file/image upload via attach button, drag/drop, and paste
- Inline rendering for image replies sent as `[MEDIA:image]/absolute/path`
- Download chips for file replies sent as `[MEDIA:file]/absolute/path`
- Mobile-friendly responsive design
- Dark theme

## Attachments

Browser uploads are stored under `~/zylos/web-console/media/` and delivered to the agent as text annotations:

```text
[attachment:image /Users/howard/zylos/web-console/media/wc-...png name="screenshot.png" 142KB]
[attachment:file /Users/howard/zylos/web-console/media/wc-...pdf name="report.pdf" 1.2MB]
```

Agent replies can include a single media row using the same C4 convention as other channels:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js web-console console "[MEDIA:image]/absolute/path/to/image.png"
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js web-console console "[MEDIA:file]/absolute/path/to/report.pdf"
```

The browser only requests media by C4 message id. The server rechecks the row is an outbound web-console console message, resolves the target with `realpath`, and serves only paths under `ZYLOS_DIR` or `/tmp`.
