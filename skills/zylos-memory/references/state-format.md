# state.md Format

## Purpose

What the bot is currently doing. The most frequently updated file. Answers:
"What was I working on before this session started?"

## Loading

Always loaded at session start via SessionStart hook.

## Size Guideline

~4KB max. This file is in every session's context. Every line must earn
its place.

## Update Frequency

Every memory sync. Also updated proactively when work focus changes.

## Sections

| Section | Content |
|---------|---------|
| `Last updated` | YYYY-MM-DD HH:MM timestamp |
| `## Current Focus` | 1-3 sentences on active work |
| `## Pending Tasks` | Checklist with requester and date |
| `## Recent Completions` | Recently finished items with date |

See `examples/state.md` for a full example.

## Rules

1. Keep it lean -- this is the tightest budget file.
2. Move completed tasks out promptly (to session log or reference files).
3. Pending tasks should include who requested and when.
4. Current Focus should reflect the most recent work, not a backlog.
5. One-off tasks belong here, not in `reference/projects.md`.
