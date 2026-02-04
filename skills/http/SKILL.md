---
name: http
description: Web server for console and file sharing. Core C6 component.
---

# HTTP Layer (C6)

Caddy-based web server providing:
- Web Console hosting
- File sharing via `~/zylos/http/public/`
- Health check endpoint

## Setup

```bash
node ~/.claude/skills/http/setup-caddy.js
```

This will:
1. Read domain from `~/zylos/.env`
2. Generate Caddyfile
3. Configure and start Caddy

## Endpoints

| Path | Description |
|------|-------------|
| `/` | File listing or index.html |
| `/console/` | Web Console interface |
| `/*.md` | Markdown documents |
| `/health` | Health check (returns "OK") |

## File Sharing

Place files in `~/zylos/http/public/` to share:

```bash
# Share a document
cp document.md ~/zylos/http/public/
chmod 644 ~/zylos/http/public/document.md

# Access at: https://your.domain.com/document.md
```

## Configuration

Domain is read from `~/zylos/.env`:
```
DOMAIN=your.domain.com
```

## Caddyfile Template

Located at `~/.claude/skills/http/Caddyfile.template`

Generated config goes to `/etc/caddy/Caddyfile`

## Adding Custom Routes

To add routes for other services, edit `/etc/caddy/Caddyfile`:

```bash
sudo nano /etc/caddy/Caddyfile
```

Add a `handle` block for your service:

```caddy
    # My Service (port 8080)
    handle /myservice/* {
        uri strip_prefix /myservice
        reverse_proxy localhost:8080
    }
```

Then reload Caddy:

```bash
sudo systemctl reload caddy
```

## HTTPS

Caddy handles HTTPS automatically via Let's Encrypt.

Requirements:
- Domain DNS pointing to server
- Ports 80 and 443 open

## Troubleshooting

```bash
# Check Caddy status
sudo systemctl status caddy

# View logs
sudo journalctl -u caddy -f

# Access logs
tail -f ~/zylos/http/caddy-access.log
```
