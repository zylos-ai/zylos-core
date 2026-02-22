<div align="center">

<img src="./assets/logo.png" alt="Zylos" height="120">

# Zylos

### Give your AI a life.


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/GS2J39EGff)
[![X](https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white)](https://x.com/ZylosAI)
[![Website](https://img.shields.io/badge/website-zylos.ai-blue)](https://zylos.ai)
[![Built by Coco](https://img.shields.io/badge/Built%20by-Coco-orange)](https://coco.xyz)

[中文](./README.zh-CN.md)

</div>

---

LLMs are geniuses — but they wake up with amnesia every session. No memory of yesterday, no way to reach you, no ability to act on their own.

Zylos gives it a life. Memory that survives restarts. A scheduler that works while you sleep. Communication through Telegram, Lark, or a web console. Self-maintenance that keeps everything running. And because it can program, it can evolve — building new skills, integrating new services, growing alongside you.

More LLMs support are on the way.

---

## Quick Start

**Prerequisites:** Git, Node.js >= 20 (via [nvm](https://github.com/nvm-sh/nvm) recommended), a Linux server (or Mac), and a [Claude](https://claude.ai) subscription.

> **Why nvm?** Installing Node.js via nvm avoids permission issues with `npm install -g`. System-level Node.js (from apt/yum) requires `sudo` for global installs, which can cause problems.

```bash
# Install (--install-links required for GitHub install; will be published to npm soon)
npm install -g --install-links https://github.com/zylos-ai/zylos-core

# Initialize — sets up tmux, PM2, memory, scheduler, and more
zylos init
```

`zylos init` is interactive and idempotent. It will:
1. Install missing tools (tmux, git, PM2, Claude Code)
2. Guide you through Claude authentication
3. Create the `~/zylos/` directory with memory, skills, and services
4. Start all background services and launch Claude in a tmux session

**Talk to your agent:**

```bash
# Attach to the Claude session
tmux attach -t claude-main

# Or add a messaging channel
zylos add telegram
zylos add lark
```

---

## Features

### One AI, One Consciousness

<div align="center">
<img src="./assets/posters/unified-context.png" alt="Unified Context" width="360">
</div>

Most agent frameworks isolate sessions per channel — your AI on Telegram doesn't know what you said on Slack. Zylos is agent-centric: your AI is one person across every channel. The C4 communication bridge routes all messages through a single gateway — one conversation, one memory, one personality. Every message persisted to SQLite and fully queryable.

### Your Context, Guaranteed

<div align="center">
<img src="./assets/posters/memory.png" alt="Inside Out Memory" width="360">
<img src="./assets/posters/infinite-context.png" alt="Infinite Context" width="360">
</div>

Other frameworks lose your AI's memory during context compaction — silently, without warning. Zylos prevents this with a two-step safeguard: when context reaches 75%, the system automatically saves all memory before compaction runs. Five-layer Inside Out memory (identity → state → references → sessions → archive) ensures the AI always knows what to keep and what to compress. Your AI never wakes up with amnesia.

### Self-Healing by Default

<div align="center">
<img src="./assets/posters/lifecycle.png" alt="Lifecycle Management" width="360">
</div>

No third-party monitoring tools needed. Zylos includes native crash recovery, heartbeat liveness probes, health monitoring, context window management, and automatic upgrades — all built in. Your AI detects its own problems and fixes them. It stays alive while you sleep.

### $20/month, Not $3,600

Other frameworks charge per API token. Community reports show monthly bills of $500–$3,600 for always-on agents. Zylos runs on your Claude subscription — flat rate, no per-token billing. Same AI capabilities, a fraction of the cost.

### Powered by Claude Code

Zylos builds on Claude Code — Anthropic's official AI agent runtime. When Anthropic ships new capabilities like agent teams, your AI gets them automatically. And because Claude Code can program, your AI writes new skills, integrates services, and evolves with your needs.

---

## Architecture

<div align="center">
<img src="./assets/posters/architecture.png" alt="Zylos Architecture" width="480">
</div>

```mermaid
graph TB
    subgraph Channels["📡 Communication Channels"]
        TG["Telegram"]
        LK["Lark"]
        WC["Web Console"]
    end

    subgraph Zylos["🧬 Zylos — The Life System"]
        C4["C4 Comm Bridge<br/>(unified gateway · SQLite audit)"]
        MEM["Memory<br/>(Inside Out architecture)"]
        SCH["Scheduler<br/>(autonomous task dispatch)"]
        AM["Activity Monitor<br/>(guardian · heartbeat · auto-recovery)"]
        HTTP["HTTP Layer<br/>(Caddy · file sharing · HTTPS)"]
    end

    subgraph Brain["🧠 Claude Code — The Brain"]
        CC["Claude Code<br/>(in tmux session)"]
    end

    TG & LK & WC --> C4
    C4 <--> CC
    MEM <--> CC
    SCH --> CC
    AM --> CC
    HTTP <--> CC
```

| Component | Role | Key Tech |
|-----------|------|----------|
| C4 Comm Bridge | Unified message gateway with audit trail | SQLite, priority queue |
| Memory | Persistent identity and context across restarts | Inside Out tiered architecture |
| Scheduler | Autonomous task dispatch while you are away | Cron, NL input, idle-gating |
| Activity Monitor | Crash recovery, heartbeat, health checks | PM2, multi-layer protection |
| HTTP Layer | Web access, file sharing, component routes | Caddy, auto-HTTPS |

---

## Communication Channels

### Built-in
- **Web Console** — Browser-based chat interface. No external accounts needed. Included with `zylos init`.

### Official Channels
Install with one command:
```bash
zylos add telegram
zylos add lark
```

### Build Your Own
All channels connect through the C4 communication bridge. To add a new channel (Slack, Discord, WhatsApp, etc.), implement the C4 protocol — a simple HTTP interface that pushes messages into the unified gateway. Your custom channel gets the same unified session, audit trail, and memory as every other channel.

---

## CLI

```bash
zylos init                    # Set up Zylos environment
zylos status                  # Check running services
zylos logs [service]          # View service logs
zylos add <component>         # Install a channel or capability
zylos upgrade <component>     # Upgrade a component
zylos list                    # List installed components
zylos search [keyword]        # Search component registry
```

---

## <img src="assets/coco-logo.png" width="28" align="center" /> Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz) — the AI employee platform.

We built Zylos because we needed it ourselves: a reliable infrastructure to keep AI running 24/7 for real work. Everything in Zylos is battle-tested in production at Coco, serving teams that depend on AI employees every day.

Want a managed experience? [Coco](https://coco.xyz) gives you a ready-to-work AI employee — with persistent memory, multi-channel communication, and skill packages — deployed in 5 minutes.

## License

[MIT](./LICENSE)
