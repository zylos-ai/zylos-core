# Zylos Core

Autonomous AI Agent Infrastructure - the minimal viable system for running a self-maintaining Claude agent.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/install.sh | bash
```

## What's Included

### Core Components (C1-C6)

| Component | Purpose | Directory |
|-----------|---------|-----------|
| C1 | Claude Runtime | (via Claude Code) |
| C2 | Self-Maintenance | `skills/self-maintenance/` |
| C3 | Memory System | `skills/memory/` |
| C4 | Communication Bridge | `skills/comm-bridge/` |
| C4+ | Web Console | `skills/web-console/` |
| C5 | Task Scheduler | `skills/scheduler/` |
| C6 | HTTP Layer | `skills/http/` |

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CORE LAYER                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ Memory   │ │   C4     │ │Scheduler │            │
│  │   C3     │ │CommBridge│ │   C5     │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                     │                               │
│              ┌──────────┐                          │
│              │ Activity │ ← Guardian               │
│              │ Monitor  │                          │
│              └──────────┘                          │
└─────────────────────────────────────────────────────┘
```

### CLI Commands

```bash
zylos status    # Show system status
zylos logs      # View logs (activity|scheduler|caddy|pm2)
zylos start     # Start services
zylos stop      # Stop services
zylos restart   # Restart services
```

## Directory Structure

### Repository Structure

```
zylos-core/
├── install.sh              # One-line install entry point
├── cli/                    # CLI commands
│   └── zylos.js
├── skills/                 # Skill implementations
│   ├── self-maintenance/   # C2
│   ├── memory/             # C3
│   ├── comm-bridge/        # C4
│   ├── web-console/        # C4 built-in channel
│   ├── scheduler/          # C5
│   └── http/               # C6
├── templates/              # Installation templates
│   ├── .env.example
│   ├── memory/
│   └── CLAUDE.md
└── docs/
```

### After Installation

```
~/.claude/skills/           # Skill code (upgradeable)
├── self-maintenance/       # Core: C2
├── memory/                 # Core: C3
├── comm-bridge/            # Core: C4
├── web-console/            # Core: C4+
├── scheduler/              # Core: C5
├── http/                   # Core: C6
├── telegram/               # Optional: Telegram channel
└── lark/                   # Optional: Lark channel

~/zylos/                    # User data (preserved)
├── .env                    # Configuration
├── memory/                 # Memory files
├── public/                 # Shared files
├── logs/                   # Log files
├── scheduler/              # Scheduler DB
├── comm-bridge/            # C4 DB
├── telegram/               # Telegram config/data
├── lark/                   # Lark config/data
└── CLAUDE.md               # Claude guidance
```

## Optional Channels

Channels are skills that implement the C4 communication interface. Install them to `~/.claude/skills/`:

- [zylos-telegram](https://github.com/zylos-ai/zylos-telegram) - Telegram integration
- [zylos-lark](https://github.com/zylos-ai/zylos-lark) - Lark/Feishu integration
- [zylos-discord](https://github.com/zylos-ai/zylos-discord) - Discord integration

Each channel skill provides `send.js` (Node.js) for outgoing messages. Channel integrations store config in `~/zylos/<channel>/`.

## Requirements

- Node.js 18+
- PM2 (auto-installed)
- Claude Code (auto-installed)

## Key Design Principles

1. **Local-first Security** - No exposed network ports
2. **Auditability** - All conversations logged to SQLite
3. **Crash Recovery** - Checkpoint mechanism for session continuity
4. **Simplicity** - Minimal code, easy to understand and maintain

## Documentation

See [docs/](./docs/) for detailed documentation.

## License

MIT License - see [LICENSE](./LICENSE)
