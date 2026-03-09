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

# 2. Set your auth token (choose one)
export ANTHROPIC_API_KEY=sk-ant-xxx
# or: export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx

# 3. Start
docker compose up -d

# 4. Follow logs
docker compose logs -f
```

That's it. Zylos will initialise its workspace on first boot (`zylos init --yes`) and start the PM2 service stack automatically. No need to copy `.env` files — the entrypoint handles everything.

## How It Works

On first start, the entrypoint:
1. Validates that an auth token is set
2. Runs `zylos init --yes` to create the workspace, `.env`, and configure auth
3. Passes through any channel tokens (Telegram, Lark) to `.env`
4. Starts PM2 services and Claude Code in a tmux session

On subsequent starts, `zylos init` is skipped (controlled by an init marker file). To force re-init, run:
```bash
docker exec zylos rm ~/zylos/.docker-init-done
docker compose restart
```

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

Two named volumes are created automatically:

| Volume | Mounted at | Contents |
|---|---|---|
| `zylos-data` | `~/zylos/` | Everything: .env, memory, workspace, logs, components, PM2 config |
| `claude-config` | `~/.claude/` | Claude Code settings and auth tokens |

> **Back up `zylos-data`**. It contains the agent's configuration, memory, and workspace. Loss = amnesia + reconfiguration.

## Environment Variables

Set variables in `docker-compose.yml`, a `.env` file alongside `docker-compose.yml`, or via `export` before running `docker compose up`.

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
| `ZYLOS_WEB_PASSWORD` | — | Web console password (auto-generated if not set) |
| `WEB_CONSOLE_PORT` | `3456` | Host port for web console |
| `HTTP_PORT` | `8080` | Host port for Caddy proxy |

## Mounting Your Own `.env`

Instead of the `environment:` block in `docker-compose.yml`, you can mount a file:

```yaml
volumes:
  - ./zylos.env:/home/zylos/zylos/.env:ro
```

When a mounted `.env` is detected, the entrypoint skips `.env` generation and uses it directly.

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

### Volume location on host

```bash
docker volume inspect zylos-core_zylos-data
```

### Force re-initialisation

```bash
docker exec zylos rm ~/zylos/.docker-init-done
docker compose restart
```
