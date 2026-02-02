# Zylos Core

Minimal viable prototype for autonomous AI agent.

## Overview

Zylos Core provides the foundational components for running an autonomous AI agent. It follows the principle of **minimal survival unit** - only essential components for agent survival and self-maintenance.

## Core Components

| Component | Purpose |
|-----------|---------|
| C1 Claude Runtime | AI reasoning engine (tmux + Claude Code) |
| C2 Self-Maintenance | Health monitoring, crash recovery, upgrades |
| C3 Memory System | Persistent memory across sessions |
| C4 Communication Bridge | Unified message gateway with logging |
| C5 Task Scheduler | Autonomous task scheduling |
| C6 HTTP Layer | Web console and file sharing |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CORE LAYER                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ Memory   │ │   C4     │ │Scheduler │            │
│  │   C3     │ │ CommBridge│ │   C5     │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                     │                               │
│              ┌──────────┐                          │
│              │ Activity │ ← Guardian               │
│              │ Monitor  │                          │
│              └──────────┘                          │
└─────────────────────────────────────────────────────┘
```

## Directory Structure

```
zylos-core/
├── core/                    # C4 Communication Bridge
│   ├── c4-receive.sh       # Receive messages from channels
│   ├── c4-send.sh          # Send messages to channels
│   ├── c4-checkpoint.sh    # Create memory sync checkpoints
│   ├── c4-recover.sh       # Recover conversations after crash
│   └── c4-db.js            # SQLite database operations
├── scripts/                 # Utility scripts
│   ├── activity-monitor.sh # C2 Self-Maintenance
│   ├── restart-claude.sh   # Restart Claude session
│   └── upgrade-claude.sh   # Upgrade Claude Code
├── channels/               # Channel send scripts (convention)
│   └── README.md           # Channel interface spec
├── docs/                   # Documentation
│   └── architecture.md     # Full architecture document
└── install.sh              # Installation script
```

## Quick Start

```bash
# Clone
git clone https://github.com/zylos-ai/zylos-core.git
cd zylos-core

# Install
./install.sh

# Start Claude in tmux
tmux new-session -d -s claude-main 'claude --resume'
```

## Key Design Principles

1. **Local-first Security** - No exposed network ports
2. **Auditability** - All conversations logged to SQLite
3. **Crash Recovery** - Checkpoint mechanism for session continuity
4. **Simplicity** - Minimal code, easy to understand and maintain

## License

Apache 2.0

## Related Repositories

- [zylos-upgrades](https://github.com/zylos-ai/zylos-upgrades) - Upgrade documentation
- [zylos-registry](https://github.com/zylos-ai/zylos-registry) - Component registry
- [zylos-telegram](https://github.com/zylos-ai/zylos-telegram) - Telegram integration
- [zylos-lark](https://github.com/zylos-ai/zylos-lark) - Lark/Feishu integration
