# OpenClaw Alignment Plan

> **Issue:** #262 · **Priority:** P1 · **Author:** Lisa · **Date:** 2026-03-08

This document compares zylos-core's current capabilities against OpenClaw's feature set and outlines a prioritised alignment plan.

---

## Reference: OpenClaw v2026.3.2 Capabilities

### Installation Methods

| Method | OpenClaw | Zylos |
|---|---|---|
| Installer script (bash) | ✅ `curl \| bash` | ✅ `curl \| bash` |
| PowerShell (Windows) | ✅ `iwr \| iex` | ❌ Not implemented |
| npm global install | ✅ `npm install -g openclaw` | ✅ `npm install -g zylos` |
| Docker | ✅ `docker-setup.sh` + Compose | ✅ (added in #261/#276) |
| From source | ✅ pnpm build | ❌ Not documented |
| Cloud deploy (Fly/Railway/GCP) | ✅ Dedicated guides | ❌ None |

### OS / Platform Support

| Platform | OpenClaw | Zylos |
|---|---|---|
| macOS | ✅ | ✅ |
| Linux | ✅ | ✅ |
| Windows (native / WSL2) | ✅ WSL2 recommended | ❌ Not tested / no docs |
| Docker (Linux container) | ✅ | ✅ (added in #261) |
| Synology NAS | ✅ (via Docker) | ✅ (via Docker, #261) |

### Chat Channel Support

| Channel | OpenClaw | Zylos | Notes |
|---|---|---|---|
| Telegram | ✅ built-in | ✅ `zylos-telegram` | Parity |
| WhatsApp | ✅ built-in | ❌ Missing | High priority — largest user base |
| Discord | ✅ built-in | ❌ Missing | High priority |
| Slack | ✅ built-in | ❌ Missing | Medium priority |
| Signal | ✅ built-in | ❌ Missing | Medium priority |
| iMessage (BlueBubbles) | ✅ built-in | ❌ Missing | macOS-only, low priority |
| Lark/Feishu | ✅ plugin | ✅ `zylos-lark` | Parity |
| LINE | ✅ plugin | ❌ Missing | Regional |
| Matrix | ✅ plugin | ❌ Missing | |
| Mattermost / MS Teams | ✅ plugin | ❌ Missing | Enterprise |
| IRC | ✅ built-in | ❌ Missing | |
| Google Chat | ✅ built-in | ❌ Missing | |
| Synology Chat | ✅ plugin | ❌ Missing | NAS-specific |
| WebChat (built-in UI) | ✅ built-in | ✅ `zylos-web-console` | Partial parity |

### Deployment

| Feature | OpenClaw | Zylos |
|---|---|---|
| PM2 process management | ❌ (daemon service) | ✅ PM2 ecosystem |
| Docker Compose | ✅ | ✅ (#261) |
| Fly.io / Railway / GCP guides | ✅ | ❌ |
| Systemd service | ✅ | ❌ |
| Ansible playbook | ✅ | ❌ |
| Auto-update | ✅ `openclaw update` | ✅ `zylos upgrade` |
| Health checks | ✅ built-in | ❌ Limited |

### Core Architecture

| Feature | OpenClaw | Zylos |
|---|---|---|
| Multi-agent sessions | ✅ | ✅ (via tmux + PM2) |
| Agent memory system | ✅ MEMORY.md + daily notes | ✅ similar structure |
| Cron / scheduler | ✅ croner | ✅ scheduler component |
| Tool / skill system | ✅ Skills + plugins | ✅ Components |
| Sandboxing (Docker) | ✅ per-session sandbox | ❌ Not implemented |
| OAuth / token auth | ✅ | ❌ |
| Usage tracking | ✅ built-in | ❌ |
| Model failover | ✅ | ❌ |
| Streaming responses | ✅ | ❌ explicit |
| TTS | ✅ node-edge-tts | ❌ |

---

## Gap Analysis Summary

### Critical Gaps (P1)

1. **WhatsApp component** — Largest messaging platform globally; OpenClaw uses Baileys (same lib already available in npm ecosystem)
2. **Discord component** — Developer community's preferred platform; high demand
3. **Windows / WSL2 support** — OpenClaw supports it; Zylos install.sh has no Windows detection

### High Priority (P2)

4. **Slack component** — Enterprise / team use cases
5. **Signal component** — Privacy-focused segment
6. **Cloud deploy guides** — Fly.io, Railway, Hetzner (one-click VPS)

### Medium Priority (P3)

7. **Agent sandboxing** — OpenClaw isolates agent tool execution in Docker; security-critical for multi-tenant
8. **Usage tracking** — Token / cost tracking per session
9. **Model failover** — Automatic fallback if primary model API fails

### Low Priority (P4)

10. iMessage (BlueBubbles) — macOS-only niche
11. IRC, Matrix, Mattermost, Teams — Niche/enterprise
12. Ansible, systemd guides — Advanced ops

---

## Recommended Implementation Roadmap

### Phase 1 — Quick Wins (1–2 weeks)

```
zylos add whatsapp   →  zylos-ai/zylos-whatsapp  (Baileys-based)
zylos add discord    →  zylos-ai/zylos-discord   (discord.js)
```

Both channels have well-maintained npm packages and follow the same component pattern as `zylos-telegram`.

**Windows / WSL2 install.sh patch:**
Add Windows detection that prints a WSL2 install guide and exits gracefully rather than failing silently.

### Phase 2 — Channels (2–4 weeks)

```
zylos add slack      →  zylos-ai/zylos-slack     (@slack/bolt)
zylos add signal     →  zylos-ai/zylos-signal    (signal-cli wrapper)
```

### Phase 3 — Deployment & Ops (4–8 weeks)

- Cloud deploy guides (Fly.io, Railway, Hetzner) — mostly documentation
- Systemd service template (parallel to PM2 ecosystem)
- Basic health check endpoint for web-console

### Phase 4 — Architecture (8+ weeks)

- Agent sandboxing (Docker-in-Docker or gVisor)
- Usage tracking (token count + cost per session/day)
- Model failover configuration

---

## Component Scaffolding Reference

New channel components should follow the same structure as `zylos-telegram`:

```
zylos-whatsapp/
├── scripts/
│   ├── service.js       ← PM2-managed process
│   └── handlers.js      ← message in/out
├── skills/              ← optional CLAUDE.md overrides
├── install.js           ← called by `zylos add whatsapp`
├── uninstall.js
└── README.md
```

Environment variables convention:
```bash
# .env additions injected by `zylos add`
WHATSAPP_PHONE=+1234567890
# (WhatsApp uses QR pairing, no token needed)
```

---

## Files to Create / Modify

| File | Action | Notes |
|---|---|---|
| `scripts/install.sh` | Modify | Add Windows/WSL2 detection |
| `registry.json` | Extend | Add whatsapp, discord, slack, signal stubs |
| `docs/channels/` | Create | Per-channel setup guides |
| `docs/deploy/` | Create | Fly.io, Railway, Hetzner guides |
| `templates/.env.example` | Extend | Add channel-specific env var examples |

---

## Conclusion

Zylos and OpenClaw share the same architectural philosophy (agent loop + PM2 + skill system) but OpenClaw has significantly broader channel coverage and better installation/deployment tooling for non-technical users.

**The highest-leverage items are WhatsApp + Discord** — adding these two channels would cover 80%+ of user demand. Both can be implemented as independent components in ~1 week each, following the existing `zylos-telegram` pattern.

Windows/WSL2 support requires only a small change to `install.sh` and can be done in a day.
