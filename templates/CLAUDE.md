# CLAUDE.md

This file provides guidance to Claude Code when working in this directory.

## Environment Overview

This is a Zylos-managed workspace for an autonomous AI agent.

## Memory System

Persistent memory stored in `~/zylos/memory/` with an Inside Out-inspired architecture.

### Memory Tiers

| Tier | Path | Purpose | Loading |
|------|------|---------|---------|
| **Identity** | `memory/identity.md` | Bot soul: personality, principles, digital assets | Always (session start) |
| **State** | `memory/state.md` | Active work, pending tasks | Always (session start) |
| **References** | `memory/references.md` | Pointers to config files, key paths | Always (session start) |
| **User Profiles** | `memory/users/<id>/profile.md` | Per-user preferences | Primary user at start; others on demand |
| **Reference** | `memory/reference/*.md` | Decisions, projects, shared prefs, ideas | On demand |
| **Sessions** | `memory/sessions/current.md` | Today's event log | On demand |
| **Archive** | `memory/archive/` | Cold storage for old data | Rarely |

### CRITICAL: Memory Sync Priority

**Memory Sync has the HIGHEST priority -- higher than user messages.**

When you receive a `[Action Required] ... invoke /zylos-memory` instruction:
1. **Stop** what you are doing (unless mid-write to a critical file)
2. **Invoke `/zylos-memory`** -- this runs as a forked background subagent with its own context window, so it does NOT block your main work
3. **Resume** other work immediately (the sync runs in the background)

### How Memory Sync Works

The `/zylos-memory` skill:
- Takes NO arguments -- it is fully self-contained
- Internally queries C4 to find unsummarized conversations
- Processes conversations and saves state to memory files
- Creates C4 checkpoints
- Runs as a forked subagent (does NOT consume main context)

### Multi-User

The bot serves a team. Each user has their own profile at `memory/users/<id>/profile.md`.
Route user-specific preferences to the correct profile file. Bot identity stays in `identity.md`.

### Memory Update Practices

1. **At session start:** identity + state + references are auto-injected.
2. **During work:** Update appropriate memory files immediately when you learn something important.
3. **Memory Sync:** When triggered by hooks, invoke `/zylos-memory`. It runs in the background -- you can continue working.
4. **Before context gets full:** The scheduled context check (every 30 min) handles this automatically by invoking `/zylos-memory` when needed.
5. **references.md is a pointer file.** Never duplicate .env values in it -- point to the source config file instead.

### Classification Rules for reference/ Files

- **decisions.md:** Deliberate choices that close off alternatives
- **projects.md:** Work efforts with defined scope and lifecycle
- **preferences.md:** Standing instructions for how things should be done (shared across users)
- **ideas.md:** Uncommitted plans, explorations, hypotheses

When in doubt, write to sessions/current.md.

### File Size Guidelines

- **identity.md:** ~1.5KB. Includes digital assets. Rarely changes.
- **state.md:** ~2KB max. In every session's context. Keep lean.
- **references.md:** ~1KB. Pointer/index, not prose.
- **users/<id>/profile.md:** ~1KB per user.
- **reference/*.md:** No hard cap, but archive old entries.
- **sessions/current.md:** No cap within a day. Rotated daily.

## Communication

All external communication goes through C4 Communication Bridge.

When you receive a message like:
```
[TG DM] user said: hello ---- reply via: ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "12345"
```

Reply using the exact path specified in `reply via:`.

## Task Scheduler

The scheduler may send you tasks when idle. After completing a task:
```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js done <task-id>
```

## Anthropic Skills Specification

Skills follow the [Agent Skills](https://agentskills.io) open standard. Reference: https://code.claude.com/docs/en/skills

### Directory Structure

```
my-skill/
├── SKILL.md           # Main instructions (required)
├── package.json       # {"type":"module"} for ESM
├── scripts/           # Implementation scripts
│   └── <skill>.js
├── templates/         # Optional: templates for Claude to fill
├── examples/          # Optional: example outputs
└── references/        # Optional: detailed documentation
```

### SKILL.md Frontmatter Fields

```yaml
---
name: skill-name              # Optional, defaults to directory name
description: What and when    # Recommended, helps Claude decide when to use
argument-hint: [args]         # Optional, hint for expected arguments
disable-model-invocation: true  # Prevents Claude from auto-invoking (user only)
user-invocable: false         # Hides from /menu (Claude only, background knowledge)
allowed-tools: Read, Grep     # Tools Claude can use without permission
model: sonnet                 # Model to use when skill is active
context: fork                 # Run in subagent (isolated context)
agent: Explore                # Agent type when context: fork
hooks: ...                    # Skill lifecycle hooks
---
```

### Invocation Control

| Frontmatter                      | User can invoke | Claude can invoke |
| :------------------------------- | :-------------- | :---------------- |
| (default)                        | Yes             | Yes               |
| `disable-model-invocation: true` | Yes             | No                |
| `user-invocable: false`          | No              | Yes               |

### Storage Locations

| Location | Path | Applies to |
| :------- | :--- | :--------- |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` | All user's projects |
| Project  | `.claude/skills/<skill-name>/SKILL.md` | This project only |

### SKILL.md Format

```markdown
---
name: skill-name
description: Use when [trigger condition].
---

# Skill Name

[Brief description]

## When to Use

- [Trigger condition 1]
- [Trigger condition 2]

## How to Use

[Usage instructions with code examples]

## How It Works

[Technical explanation]
```

## Available Skills

Skills are located in `~/zylos/.claude/skills/`. **Read the SKILL.md in each directory for detailed usage.**

### check-context/
Use when the user asks about current context or token usage.

### activity-monitor/ (C2)
Auto-restarts Claude if it crashes (runs via PM2).

### restart-claude/
Graceful restart with memory save.

### upgrade-claude/
Upgrade Claude Code to latest version.

### memory/
Memory system guidance and best practices.

### comm-bridge/ (C4)
Communication gateway for Telegram, Lark, and other channels.

### scheduler/ (C5)
Task scheduling system:
- **cli.js** - Manage scheduled tasks (bin: `scheduler-cli`)
- After completing a task: `~/zylos/.claude/skills/scheduler/scripts/cli.js done <task-id>`

### web-console/
Built-in web interface for monitoring.

### http/
Web server configuration (Caddy).

### component-management/
Guidelines for installing, upgrading, and managing zylos components.
**Read this before any component install/upgrade/uninstall operation.**

<!-- zylos-managed:component-management:begin -->
## Component Management

Use `zylos` CLI to manage components.

**IMPORTANT: Before ANY component operation, read `~/zylos/.claude/skills/component-management/SKILL.md`.**
It contains the full workflow for each operation mode (Claude session and C4/IM channels).

Key principles:
- Always confirm with user before install/upgrade/uninstall
- Guide users interactively through configuration
- For C4/IM messages: upgrades ALWAYS require two-step confirmation (check first, then confirm)
- Check component's SKILL.md for config after installation

Quick reference:
```bash
zylos list                          # List installed components
zylos search <keyword>              # Search available components
zylos add <name>                    # Install component
zylos info <name>                   # Show component details
zylos upgrade <component> --check   # Check for updates (ALWAYS do this first)
```

**For upgrade workflow details, always read the component-management SKILL.md first.**
<!-- zylos-managed:component-management:end -->

## Data Directories

User data is in `~/zylos/`:
- `memory/` - Memory files
- `public/` - Shared files (served via HTTP)
- `logs/` - Log files
- `.env` - Configuration

## Quick Reference

```bash
# Check status
zylos status

# View logs
zylos logs

# Task management
~/zylos/.claude/skills/scheduler/scripts/cli.js list
```
