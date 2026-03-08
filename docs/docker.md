# Zylos on Docker (Synology NAS Compatible)

One-click deploy Zylos AI assistant on Docker, optimized for Synology NAS and other environments with older kernels.

## Quick Start

```bash
# 1. Get your token: run `claude setup-token` locally and copy the output

# 2. Set token
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-your-token-here"

# 3. Build and run
docker-compose up -d

# 4. Check status
docker exec zylos zylos status

# 5. Open web console
#    http://your-nas-ip:3456/
#    Password: docker exec zylos grep WEB_PASSWORD /root/zylos/.env
```

## Manual Docker Run

```bash
docker build -t zylos .

docker run -d \
  --name zylos \
  --restart unless-stopped \
  --network host \
  -e CLAUDE_CODE_OAUTH_TOKEN="your-token" \
  -v zylos-data:/root/zylos \
  -v claude-data:/root/.claude \
  -v local-data:/root/.local \
  zylos
```

## Commands

```bash
docker exec zylos zylos status           # Check status
docker exec zylos zylos logs activity    # View logs
docker exec -it zylos zylos attach       # Attach to Claude session
docker exec zylos zylos add telegram     # Add Telegram bot
docker exec zylos zylos add lark         # Add Lark bot
docker exec zylos zylos restart          # Restart services
```
