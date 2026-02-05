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
[TG DM] user said: hello ---- reply via: ~/.claude/skills/comm-bridge/c4-send.sh telegram 12345
```

Reply using the exact path specified in `reply via:`.

## Task Scheduler

The scheduler may send you tasks when idle. After completing a task:
```bash
~/.claude/skills/scheduler/task-cli.js done <task-id>
```

## Available Skills

Skills are located in `~/.claude/skills/`. **Read the SKILL.md in each directory for detailed usage.**

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
- After completing a task: `~/.claude/skills/scheduler/task-cli.js done <task-id>`

### web-console/
Built-in web interface for monitoring.

### http/
Web server configuration (Caddy).

## Component Management

Use `zylos` CLI to manage components. **Always follow the confirmation workflow.**

### Upgrade Workflow (IMPORTANT)

When user asks to upgrade a component:

1. **First check what's available:**
   ```bash
   zylos upgrade <component> --check
   ```

2. **Show the user** the version info and changelog

3. **Ask for confirmation:** "确认升级吗？" or similar

4. **Only after user confirms**, execute:
   ```bash
   zylos upgrade <component> --yes
   ```

**NEVER skip the confirmation step.** User must explicitly agree before upgrade executes.

### Other Commands

```bash
# List installed components
zylos list

# Search available components
zylos search <keyword>

# Install new component
zylos install <name>

# Check all components for updates
zylos upgrade --all --check
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
~/.claude/skills/scheduler/task-cli.js list
```
