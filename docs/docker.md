# Docker Deployment

Zylos can be run inside a Docker container — useful for platforms like Synology NAS, VPS, or any environment where running the native install script is impractical.

## Prerequisites

- Docker 24+ and Docker Compose v2
- An Anthropic API key **or** Claude Code OAuth token

## Quick Start

```bash
# 1. Clone (or download docker-compose.yml only)
git clone https://github.com/zylos-ai/zylos-core.git
cd zylos-core

# 2. Configure
cp .env.example zylos.env
# Edit zylos.env — set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)

# 3. Start
docker compose up -d

# 4. Follow logs
docker compose logs -f
```

That's it. Zylos will initialise its workspace on first boot and start the PM2 service stack automatically.

## Architecture

```
docker container: zylos
├── tmux session: claude-main       ← Claude Code AI loop
└── PM2 services
    ├── scheduler                   ← cron / heartbeat
    ├── web-console                 ← browser UI (port 3456)
    ├── c4-dispatcher               ← message routing bridge
    ├── activity-monitor            ← liveness / state tracking
    ├── caddy (optional)            ← reverse proxy (port 8080)
    └── channel adapters            ← telegram, lark, etc.
```

## Persistent Data

Three named volumes are created automatically:

| Volume | Mounted at | Contents |
|---|---|---|
| `zylos-memory` | `~/zylos/memory/` | Agent memory files (daily notes, MEMORY.md) |
| `zylos-workspace` | `~/zylos/workspace/` | Files created/edited by the AI |
| `zylos-logs` | `~/zylos/logs/` | PM2 service logs |

> ⚠️ **Back up `zylos-memory`**. It contains the agent's long-term memory and daily notes. Loss = amnesia.

## Environment Variables

All variables can be set in `docker-compose.yml` or via an `.env` file in the project directory.

### Required (choose one auth method)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (usage-based billing) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code token (Pro/Max subscription) |

### Optional

| Variable | Default | Description |
|---|---|---|
| `TZ` | `UTC` | Timezone for scheduler (IANA format, e.g. `Asia/Singapore`) |
| `CLAUDE_BYPASS_PERMISSIONS` | `true` | Run Claude with `--dangerously-skip-permissions` |
| `TELEGRAM_BOT_TOKEN` | — | Telegram channel token |
| `LARK_APP_ID` / `LARK_APP_SECRET` | — | Lark/Feishu app credentials |
| `ZYLOS_WEB_PASSWORD` | — | Web console password |
| `WEB_CONSOLE_PORT` | `3456` | Host port for web console |
| `HTTP_PORT` | `8080` | Host port for Caddy proxy |

## Mounting Your Own `.env`

Instead of the `environment:` block in `docker-compose.yml`, you can mount a file:

```yaml
volumes:
  - ./zylos.env:/home/zylos/zylos/.env:ro
```

## Synology NAS (DSM)

1. Open **Container Manager** → **Project** → **Create**
2. Upload `docker-compose.yml` and set environment variables in the GUI
3. Start the project

Or via SSH:
```bash
ssh admin@<nas-ip>
cd /volume1/docker/zylos
docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```

## Troubleshooting

### Claude Code not starting

```bash
# Check tmux session
docker exec -it zylos tmux attach -t claude-main

# Check Claude auth
docker exec -it zylos claude auth status
```

### PM2 services not running

```bash
docker exec -it zylos pm2 status
docker exec -it zylos pm2 logs --lines 50
```

### Memory volume location on host

```bash
docker volume inspect zylos-core_zylos-memory
```
