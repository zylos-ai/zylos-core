# references.md Format

## Purpose

A lookup table that points to configuration sources rather than duplicating
their values. Prevents drift between references.md and the actual config files.

## Loading

Always loaded at session start via SessionStart hook.

## Size Guideline

~2KB. Pointer/index only, not prose.

## Update Frequency

When services or paths change. Not every sync cycle.

## Sections

| Section | Content |
|---------|---------|
| `## Configuration Sources` | Pointers to .env, components.json, etc. |
| `## Key Paths` | Memory, skills, skill data directories |
| `## Services` | Endpoints/ports (credentials in .env) |
| `## Active IDs` | Only IDs needed for current work context |
| `## Notes` | Reminders about pointer-only policy |

See `examples/references.md` for a full example.

## Rules

1. NEVER duplicate a value that exists in `.env` or another config file.
2. Point to the source instead:
   - Instead of `TZ: Asia/Shanghai`, write `TZ: see .env`
   - Instead of listing API keys, write `API keys: see .env`
3. Keep entries as terse pointers, not explanations.
4. Active IDs section is for IDs needed in current context only.
