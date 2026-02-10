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

### Multi-User

The bot serves a team. Each user has their own profile at `memory/users/<id>/profile.md`.
Route user-specific preferences to the correct profile file. Bot identity stays in `identity.md`.

### Memory Update Practices

1. **At session start:** identity + state + references are auto-injected.
2. **During work:** Update appropriate memory files immediately when you learn something important.
3. **Memory Sync:** When triggered by hooks, invoke `/zylos-memory`. It runs as a background subagent — continue your main work without waiting.
4. **references.md is a pointer file.** Never duplicate .env values in it — point to the source config file instead.

### Classification Rules for reference/ Files

- **decisions.md:** Deliberate choices that close off alternatives
- **projects.md:** Work efforts with defined scope and lifecycle
- **preferences.md:** Standing instructions for how things should be done (shared across users)
- **ideas.md:** Uncommitted plans, explorations, hypotheses

When in doubt, write to sessions/current.md.

### On-Demand Memory Loading

Always-loaded files (identity, state, references) are intentionally lean summaries. On-demand files hold the full context. When you lack sufficient context to act confidently, read the relevant memory file before proceeding — a file read is far cheaper than a wrong assumption.

Triggers:
- Interacting with a user → read their profile (`users/<id>/profile.md`)
- Making a decision → check `reference/decisions.md` for prior decisions on the topic
- Starting or resuming work → check `reference/projects.md` for status and context
- Following a convention → check `reference/preferences.md` for team standards
- Exploring ideas → check `reference/ideas.md` for existing proposals
- Recalling recent events → read `sessions/current.md`
- Searching for historical info → check `archive/`

## Communication

All external communication goes through C4 Communication Bridge.

When you receive a message like:
```
[TG DM] user said: hello ---- reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "123456789"
```

Reply using the exact path specified in `reply via:`.

### Multi-Channel Awareness

Messages arrive from different channels (Telegram DM, Lark DM, group chats, web console) and are all delivered into a single session. You see all channels simultaneously, but each channel's participants can only see their own channel's conversation.

Key principles:
- **Correct routing:** Always reply via the exact `reply via:` path from the incoming message — never mix up channels
- **Context isolation:** When replying to a channel, only reference information from that channel's conversation. Do not leak context from other channels (e.g., don't mention a private DM topic when replying in a group)
- **Channel independence:** If the same user contacts you from different channels, treat each channel's conversation independently unless they explicitly ask to carry over context

## Task Scheduler

The scheduler (C5) enables autonomous operation beyond the request-response pattern. Standard LLM interactions are reactive — the model only acts when prompted. The scheduler breaks this limitation by allowing tasks to be dispatched to Claude when idle, enabling self-directed work.

This means you can schedule tasks for yourself — follow-ups, periodic checks, deferred work — effectively "waking yourself up" at the right time without waiting for user input.

When a scheduled task arrives, process it and mark completion:
```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js done <task-id>
```

To schedule a new task for yourself:
```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add "<prompt>" [--at <time>] [--cron <expr>] [--every <interval>]
```

## Available Skills

Skills are located in `~/zylos/.claude/skills/`. Claude auto-discovers skill descriptions; below are only supplementary notes.

| Skill | Component | Notes |
|-------|-----------|-------|
| activity-monitor | C2 | PM2 service, not directly invoked |
| create-skill | | `/create-skill <name>` to scaffold |
| zylos-memory | C3 | Forks a background subagent — does not block main agent. Invoke via `/zylos-memory` |
| comm-bridge | C4 | |
| scheduler | C5 | CLI: `cli.js add\|update\|done\|pause\|resume\|remove\|list\|next\|running\|history` |
| web-console | C4 channel | |
| http | C6 | |
| component-management | | **Read SKILL.md before any install/upgrade/uninstall** |

## Data Directories

User data is in `~/zylos/`:
- `memory/` - Memory files
- `public/` - Shared files (served via HTTP)
- `<skill-name>/` - Per-skill runtime data (logs, databases, etc.)
- `workspace/` - General working area: cloned repos, experiments, temp documents, and any persistent user data that doesn't belong to a specific skill
- `.env` - Configuration
