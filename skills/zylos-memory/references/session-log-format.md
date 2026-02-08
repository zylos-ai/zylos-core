# Session Log Format

Session logs live in `~/zylos/memory/sessions/`. The active file is `current.md`; past logs are archived as `YYYY-MM-DD.md`.

## Header

Every session log starts with a date header (written by `rotate-session.js`):

```markdown
# Session Log: 2026-02-08
```

## Entry Format

Each entry uses a level-2 heading with timestamp and title, followed by bullet-point details:

```markdown
## HH:MM - Title
- Detail line 1
- Detail line 2
```

- **HH:MM**: 24-hour format in local TZ.
- **Title**: Brief summary of what happened (imperative or past tense).
- **Details**: What changed, which files were updated, key outcomes.

See `examples/session-log.md` for a full example.

## Rules

1. `current.md` is **append-only** within a day. Never rewrite earlier entries.
2. Use `## HH:MM - Title` for each entry (24h format, local TZ).
3. Keep entries concise -- capture what happened and what changed, not full conversation.
4. When in doubt about where to write something, write it to `sessions/current.md`.
5. Rotation happens automatically at day boundary; do not manually rename `current.md`.
