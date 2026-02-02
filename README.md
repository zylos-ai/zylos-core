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
│   ├── pm2.config.js
│   └── CLAUDE.md
├── channels/               # Channel interface examples
└── docs/
```

### After Installation

```
~/.claude/skills/           # Skill code (upgradeable)
├── self-maintenance/
├── memory/
├── comm-bridge/
├── web-console/
├── scheduler/
└── http/

~/zylos/                    # User data (preserved)
├── .env                    # Configuration
├── memory/                 # Memory files
├── public/                 # Shared files
├── logs/                   # Log files
├── pm2.config.js          # Service config
└── CLAUDE.md              # Claude guidance
```

## Optional Channels

Install additional communication channels:

- [zylos-telegram](https://github.com/zylos-ai/zylos-telegram) - Telegram integration
- [zylos-lark](https://github.com/zylos-ai/zylos-lark) - Lark/Feishu integration
- [zylos-discord](https://github.com/zylos-ai/zylos-discord) - Discord integration

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
