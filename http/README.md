# C6 HTTP Layer

HTTP server component for Zylos Core, providing file sharing and optional reverse proxy capabilities.

## Features

- **File Sharing**: Serve documents from `~/zylos/public/` via HTTPS
- **Markdown Support**: Raw markdown files served with proper content type
- **Health Check**: `/health` endpoint for monitoring
- **Optional Proxies**: Lark webhook, VNC/browser automation

## Quick Start

```bash
# 1. Ensure DOMAIN is set in ~/zylos/.env
echo "DOMAIN=your.domain.com" >> ~/zylos/.env

# 2. Run setup
./setup-caddy.sh

# 3. With optional components
./setup-caddy.sh --with-lark --with-browser
```

## Configuration

### Required: Domain

Set your domain in `~/zylos/.env`:

```bash
DOMAIN=zylos.example.com
```

### File Structure

```
~/zylos/
├── .env                 # Contains DOMAIN
├── public/              # Files served via HTTP
│   ├── index.html       # (optional) Landing page
│   └── *.md             # Shared documents
├── logs/
│   └── caddy-access.log # HTTP access logs
└── Caddyfile            # Generated config
```

## Sharing Documents

```bash
# 1. Place file in public directory
cp document.md ~/zylos/public/

# 2. Ensure readable permissions
chmod 644 ~/zylos/public/document.md

# 3. Access via browser
# https://your.domain.com/document.md
```

## Endpoints

| Path | Description |
|------|-------------|
| `/` | File listing (if index.html exists) |
| `/*.md` | Markdown documents |
| `/health` | Health check (returns "OK") |
| `/lark/*` | Lark webhook proxy (optional) |
| `/vnc/*` | noVNC proxy (optional) |
| `/ws` | Browser WebSocket (optional) |

## Manual Configuration

If you prefer manual setup:

1. Copy template: `cp Caddyfile.template ~/zylos/Caddyfile`
2. Replace `{DOMAIN}` with your domain
3. Replace `{ZYLOS_DIR}` with full path (e.g., `/home/user/zylos`)
4. Uncomment optional sections as needed
5. Apply: `sudo cp ~/zylos/Caddyfile /etc/caddy/Caddyfile && sudo systemctl restart caddy`

## Troubleshooting

### 403 Forbidden
```bash
# Fix permissions
chmod o+rx ~
chmod o+rx ~/zylos
chmod -R o+r ~/zylos/public
```

### Certificate Issues
Caddy handles HTTPS automatically. Ensure:
- Domain DNS points to your server
- Ports 80 and 443 are open
- No other service using those ports

### Check Logs
```bash
# Caddy service logs
sudo journalctl -u caddy -f

# Access logs
tail -f ~/zylos/logs/caddy-access.log
```
