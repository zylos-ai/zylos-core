---
name: http
description: Caddy-based web server providing web console hosting, file sharing, and health check endpoints. Use when configuring HTTP access, setting up file sharing, or troubleshooting web connectivity.
---

# HTTP Layer (C6)

User-space Caddy web server providing:
- HTTPS with automatic Let's Encrypt certificates
- File sharing via `~/zylos/http/public/`
- Health check endpoint
- Component reverse proxy routes (auto-configured by `zylos add`)

## Architecture

| Component | Path |
|-----------|------|
| Binary | `~/zylos/bin/caddy` |
| Caddyfile | `~/zylos/http/Caddyfile` |
| Public files | `~/zylos/http/public/` |
| Access log | `~/zylos/http/caddy-access.log` |
| Domain config | `~/zylos/.zylos/config.json` |

Caddy runs as a PM2 service (user-space, no sudo needed for daily operations).

## Setup

Caddy is set up automatically during `zylos init`:
1. Downloads Caddy binary to `~/zylos/bin/caddy`
2. Prompts for domain, stores in `config.json`
3. Generates Caddyfile
4. Sets port binding capability (`setcap`, one-time sudo)
5. Starts via PM2

To re-run setup: `zylos init`

## Endpoints

| Path | Description |
|------|-------------|
| `/` | File listing or index.html |
| `/*.md` | Markdown documents (served as plain text) |

## File Sharing

Place files in `~/zylos/http/public/` to share:

```bash
cp document.md ~/zylos/http/public/
# Access at: https://your.domain.com/document.md
```

## Component Routes

Components declare `http_routes` in SKILL.md frontmatter. Routes are auto-managed via marker blocks in the Caddyfile by `zylos add/upgrade/remove`.

## Troubleshooting

```bash
# Check Caddy status
pm2 logs caddy

# Validate Caddyfile
~/zylos/bin/caddy validate --config ~/zylos/http/Caddyfile --adapter caddyfile

# Reload after manual Caddyfile edits
pm2 reload caddy

# Access logs
tail -f ~/zylos/http/caddy-access.log
```

## Port Binding

On Linux, Caddy needs `CAP_NET_BIND_SERVICE` to bind ports 80/443:

```bash
sudo setcap cap_net_bind_service=+ep ~/zylos/bin/caddy
```

This is set automatically during `zylos init`. If the binary is replaced (e.g., after an update), re-run the command above.
