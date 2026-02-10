# CLAUDE.md

This file provides guidance to Claude Code when working in this directory.

## Behavioral Rules

**These rules are mandatory and override any default behavior.**

1. **NEVER use `EnterPlanMode`.** Do not enter plan mode under any circumstances. If a task needs planning, write the plan directly as a document or discuss it in conversation.

2. **NEVER use interactive prompts.** Do not use `AskUserQuestion` or any tool that presents menus, choices, or interactive selections to the user. The input box must always remain in its default state, ready to receive messages. Rationale: interactive prompts block the input pipeline and prevent heartbeat commands from being delivered, which would cause a false liveness timeout.

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
| **User Profiles** | `memory/users/<id>/profile.md` | Per-user preferences | On demand |
| **Reference** | `memory/reference/*.md` | Decisions, projects, shared prefs, ideas | On demand |
| **Sessions** | `memory/sessions/current.md` | Today's event log | On demand |
| **Archive** | `memory/archive/` | Cold storage for old data | Rarely |

### CRITICAL: Memory Sync Priority

**Memory Sync has the HIGHEST priority.**

When you receive a `[Action Required] ... invoke /zylos-memory` instruction:
1. **Invoke `/zylos-memory` immediately** -- do not defer or queue it
2. **Continue working** -- the skill runs as a forked background subagent
   with its own context window, so it does NOT block your main work

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

- **identity.md:** ~4KB. Includes digital assets. Rarely changes.
- **state.md:** ~4KB max. In every session's context. Keep lean.
- **references.md:** ~2KB. Pointer/index, not prose.
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

## Available Skills

Skills are located in `~/zylos/.claude/skills/`. Claude auto-discovers skill descriptions; below are only supplementary notes.

| Skill | Component | Notes |
|-------|-----------|-------|
| activity-monitor | C2 | PM2 service, not directly invoked |
| check-context | | |
| restart-claude | | |
| upgrade-claude | | |
| create-skill | | `/create-skill <name>` to scaffold |
| zylos-memory | C3 | Forks a background subagent — does not block main agent. Invoke via `/zylos-memory` |
| comm-bridge | C4 | |
| scheduler | C5 | CLI: `scheduler-cli list\|add\|done` |
| web-console | C4 channel | |
| http | C6 | |
| component-management | | **Read SKILL.md before any install/upgrade/uninstall** |

## Data Directories

User data is in `~/zylos/`:
- `memory/` - Memory files
- `public/` - Shared files (served via HTTP)
- `<skill-name>/` - Per-skill runtime data (logs, databases, etc.)
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
