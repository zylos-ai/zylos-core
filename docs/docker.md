# Docker Deployment

Zylos can be run inside a Docker container — useful for platforms like Synology NAS, VPS, or any environment where running the native install script is impractical.

## Prerequisites

- Docker 24+
- A Claude Code OAuth token **or** Anthropic API key

## Quick Start

The `latest` image tracks the highest stable release; `main` is a development
image. To pin a release, use its explicit image version tag (for example, `:0.9.4`).

### Option A: Docker Run (simplest)

```bash
docker run -d --name zylos \
  -e CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE \
  -p 3470:3470 \
  -v zylos-data:/home/zylos/zylos \
  -v claude-config:/home/zylos/.claude \
  ghcr.io/zylos-ai/zylos-core:latest
```

Open `http://localhost:3470/` to access Dashboard and its Origin conversation.

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

The compose file supports timezone, channel tokens (Telegram, Lark), and more — edit it or pass via environment variables.

### Dashboard Password

Container startup runs `zylos init --yes --quiet`. It generates a Dashboard
password when needed but never prints that password to startup output or
`docker logs`. After startup, run this directly in your terminal:

```bash
docker exec -it zylos zylos dashboard reset-password
```

The command generates a new password and displays it once in that terminal.
Save it privately. Reset enables authentication, clears existing browser/API
sessions (including remembered logins), and restarts a running Dashboard.
Outside Docker, use `zylos dashboard reset-password` on the host. Non-quiet
interactive init continues to display its newly generated password once.

### Talk to Your Agent

```bash
# Interactive CLI — the simplest way to chat
docker exec -it zylos zylos shell
```

Or open `http://localhost:3470/` and use the Origin conversation in Dashboard.

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

Running `zylos init` on every startup ensures that template files (skills, PM2 config) stay in sync when the Docker image is updated. It also retries Web Console removal: old code is moved to `.backup`, generated routing and password lines are removed, and the upload limit is renamed to `DASHBOARD_MAX_UPLOAD_MB`. Historical conversations and media remain intact.

## Architecture

```
docker container: zylos
├── tmux session: claude-main (or codex-main)  ← AI agent loop (runtime-dependent)
└── PM2 services
    ├── scheduler                   ← cron / heartbeat
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
| `DASHBOARD_PORT` | `3470` | Host port mapped to Dashboard's container port 3470 |
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
  -p 3470:3470 \
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
docker exec -it zylos tmux attach -t claude-main   # or codex-main for Codex runtime

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

