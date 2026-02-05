# CLAUDE.md

This file provides guidance to Claude Code when working in this directory.

## Environment Overview

This is a Zylos-managed workspace for an autonomous AI agent.

## Memory System

Persistent memory stored in `~/zylos/memory/`:
- `context.md` - Current work focus
- `decisions.md` - Key decisions made
- `projects.md` - Active/planned projects
- `preferences.md` - User preferences

**Important Practices:**
1. **Start each session** by reading memory files
2. **Update memory frequently** - don't wait until context is full
3. **Before context compaction** - always update memory first

## Communication

All external communication goes through C4 Communication Bridge.

When you receive a message like:
```
[TG DM] user said: hello ---- reply via: ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 12345
```

Reply using the exact path specified in `reply via:`.

## Task Scheduler

The scheduler may send you tasks when idle. After completing a task:
```bash
~/zylos/.claude/skills/scheduler/scripts/task-cli.js done <task-id>
```

## Skills Specification

Skills follow the [Agent Skills](https://agentskills.io) open standard.

### Directory Structure

```
skill-name/
├── SKILL.md           # Main instructions (required)
├── package.json       # {"type":"module"} for ESM
└── scripts/           # Implementation scripts
    └── <skill>.js
```

### SKILL.md Frontmatter

```yaml
---
name: skill-name              # Optional, defaults to directory name
description: What and when    # Recommended, helps Claude decide when to use
disable-model-invocation: true  # User only (Claude can't auto-invoke)
user-invocable: false         # Claude only (hidden from /menu)
allowed-tools: Read, Grep     # Tools without permission prompt
model: sonnet                 # Model for this skill
---
```

## Available Skills

Skills are located in `~/zylos/.claude/skills/`. **Read the SKILL.md in each directory for detailed usage.**

### check-context/
Use when the user asks about current context or token usage.

### self-maintenance/ (C2)
Health monitoring and maintenance tools:
- **activity-monitor.js** - Auto-restarts Claude if it crashes (runs via PM2)
- **restart-claude.js** - Graceful restart with memory save
- **upgrade-claude.js** - Upgrade Claude Code to latest version

### memory/
Memory system guidance and best practices.

### comm-bridge/ (C4)
Communication gateway for Telegram, Lark, and other channels.

### scheduler/ (C5)
Task scheduling system:
- **task-cli.js** - Manage scheduled tasks
- After completing a task: `~/zylos/.claude/skills/scheduler/scripts/task-cli.js done <task-id>`

### web-console/
Built-in web interface for monitoring.

### http/
Web server configuration (Caddy).

### component-management/
Guidelines for installing, upgrading, and managing zylos components.
**Read this before any component install/upgrade operation.**

## Component Management

Use `zylos` CLI to manage components.

**Read `~/zylos/.claude/skills/component-management/SKILL.md` for detailed workflows.**

Key principles:
- Always confirm with user before install/upgrade/uninstall
- Guide users interactively through configuration (never just say "edit file manually")
- Check component's SKILL.md for config after installation

Quick reference:
```bash
zylos list                          # List installed components
zylos search <keyword>              # Search available components
zylos install <name>                # Install component
zylos upgrade <component> --check   # Check for updates
zylos upgrade <component> --yes     # Execute upgrade (after user confirms)
```

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
~/zylos/.claude/skills/scheduler/scripts/task-cli.js list
```
