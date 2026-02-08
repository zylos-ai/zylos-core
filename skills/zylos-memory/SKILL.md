---
name: zylos-memory
description: >-
  Core memory system. Maintains persistent memory across sessions via tiered
  markdown files following the Inside Out model. Handles Memory Sync (processing
  conversations into structured memory), session rotation, consolidation, and
  context-aware state saving. Runs as a forked subagent and does not block the
  main agent. Invoke with /zylos-memory (no arguments).
context: fork
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Memory System

Maintains persistent memory across sessions via tiered markdown files.
This skill runs as a forked subagent with its own isolated context window.

## Architecture

```text
~/zylos/memory/
├── identity.md              # Bot soul + digital assets (always loaded)
├── state.md                 # Active working state (always loaded)
├── references.md            # Pointers to config files (always loaded)
├── users/
│   └── <id>/profile.md      # Per-user preferences
├── reference/
│   ├── decisions.md         # Key decisions with rationale
│   ├── projects.md          # Active/planned projects
│   ├── preferences.md       # Shared team preferences
│   └── ideas.md             # Uncommitted plans and ideas
├── sessions/
│   ├── current.md           # Today's session log
│   └── YYYY-MM-DD.md        # Past session logs
└── archive/                 # Cold storage
```

## Memory Sync

### Priority

Memory Sync is the highest-priority internal maintenance task.
When triggered, run it before handling queued user messages.

### Trigger Paths

1. Session init: if C4 unsummarized count is over threshold, invoke `/zylos-memory`.
2. Scheduled context check: if context usage is high, invoke `/zylos-memory`.

Both use `/zylos-memory` with no arguments.

### Sync Flow

1. Rotate session log if needed:
   `node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js`
2. Fetch unsummarized conversations:
   `node ~/zylos/.claude/skills/zylos-memory/scripts/memory-sync.js fetch`
3. Read memory files (`identity.md`, `state.md`, `references.md`, user profiles, `reference/*`, `sessions/current.md`).
4. Extract and classify updates into the correct files.
5. Write memory updates (flush always runs, even if no new conversations).
6. Create checkpoint when a batch was processed:
   `node ~/zylos/.claude/skills/zylos-memory/scripts/memory-sync.js checkpoint --summary "SUMMARY"`
7. Run daily commit helper:
   `node ~/zylos/.claude/skills/zylos-memory/scripts/daily-commit.js`
8. Confirm completion.

## Classification Rules

- `reference/decisions.md`: committed choices that close alternatives.
- `reference/projects.md`: scoped work efforts with status.
- `reference/preferences.md`: standing team-wide preferences.
- `reference/ideas.md`: uncommitted proposals.
- `users/<id>/profile.md`: user-specific preferences.
- `state.md`: active focus and pending tasks.
- `references.md`: pointers only; do not duplicate `.env` values.

## Session Log Format

See `references/session-log-format.md` for format definition and rules.
See `examples/session-log.md` for a full example.

## Supporting Scripts

- `session-start-inject.js`: prints core memory context blocks for hooks.
- `rotate-session.js`: rotates `sessions/current.md` at day boundary.
- `memory-sync.js`: fetch/checkpoint/status helper over C4 DB state.
- `daily-commit.js`: local git snapshot for `memory/` if changed.
- `consolidate.js`: JSON consolidation report (sizes, age, budget checks).
- `memory-status.js`: quick health summary.

## Best Practices

1. Keep `state.md` lean (tight context budget).
2. Prefer updates over duplication.
3. Use explicit dates/timestamps for entries.
4. Archive instead of deleting historical data.
5. Route user data to user profiles.
6. Keep configuration values in config files; use `references.md` as an index.
