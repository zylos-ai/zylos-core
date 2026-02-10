---
name: web-console
description: Built-in web interface for communicating with Claude without external services. Use when setting up or configuring the web console channel, or troubleshooting browser-based access.
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
| `/api/send` | POST | Send message to Claude |
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
| `ZYLOS_DIR` | ~/zylos | Data directory |

## Features

- Real-time status indicator (busy/idle/offline)
- Message polling every 2 seconds
- Auto-resizing input
- Mobile-friendly responsive design
- Dark theme
