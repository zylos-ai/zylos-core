# Docker Deployment

Zylos can be run inside a Docker container — useful for platforms like Synology NAS, VPS, or any environment where running the native install script is impractical.

## Prerequisites

- Docker 24+
- A Claude Code OAuth token **or** Anthropic API key

## Quick Start

### Option A: Docker Run (simplest)

```bash
docker run -d --name zylos \
  -e CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE \
  -p 3456:3456 \
  -v zylos-data:/home/zylos/zylos \
  -v claude-config:/home/zylos/.claude \
  ghcr.io/zylos-ai/zylos-core:latest
```

Open `http://localhost:3456` to access the web console.

### Option B: Docker Compose (more config options)

```bash
mkdir zylos && cd zylos
curl -fsSLO https://raw.githubusercontent.com/zylos-ai/zylos-core/main/docker-compose.yml
```

Set your token and start:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE
docker compose up -d
```

The compose file supports timezone, channel tokens (Telegram, Lark), web console password, and more — edit it or pass via environment variables.

### Web Console Password

A random password is generated on first boot. Two ways to find it:

**From startup logs:**
```bash
docker logs zylos | grep -A2 "Web Console"
```

**Via the Claude shell (after startup completes):**
```bash
docker exec -it zylos zylos shell
# Then ask: "What's my web console password?"
```

### Verify

```bash
# Check services
docker exec zylos pm2 status

# Follow logs
docker logs -f zylos
```

That's it. Zylos initialises its workspace on first boot and starts all services automatically.

## How It Works

On every start, the entrypoint:
1. Validates that an auth token is set
2. Runs `zylos init --yes` to create/update the workspace, `.env`, and configure auth
3. Passes through any channel tokens (Telegram, Lark) to `.env`
4. Starts PM2 services and Claude Code in a tmux session

Running `zylos init` on every startup ensures that template files (skills, PM2 config) stay in sync when the Docker image is updated. The init command is idempotent — it only creates missing files and syncs templates, never overwrites user data.

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
| `claude-config` | `~/.claude/` | Claude Code settings and auth tokens. Persists login state so Claude doesn't need to re-authenticate on container restart. Auth is also re-configured by the entrypoint on each boot, so this volume is optional but recommended. |

> **Back up `zylos-data`**. It contains the agent's configuration, memory, and workspace. Loss = amnesia + reconfiguration.

## Environment Variables

Set variables in `docker-compose.yml`, a `.env` file alongside `docker-compose.yml`, or via `export` before running `docker compose up`.

### Required (choose one auth method)

| Variable | Description |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code token (Pro/Max subscription) |
| `ANTHROPIC_API_KEY` | Anthropic API key (usage-based billing) |

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

**Docker Run:**
```bash
docker pull ghcr.io/zylos-ai/zylos-core:latest
docker stop zylos && docker rm zylos
docker run -d --name zylos \
  -e CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE \
  -p 3456:3456 \
  -v zylos-data:/home/zylos/zylos \
  -v claude-config:/home/zylos/.claude \
  ghcr.io/zylos-ai/zylos-core:latest
```

**Docker Compose:**
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

