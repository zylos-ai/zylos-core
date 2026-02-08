# preferences.md Format

## Purpose

Shared preferences that apply across all users and across the bot's
operation. Standing instructions that don't have a decision moment --
they are observed patterns or stated preferences.

## Location

`reference/preferences.md`

## Size Guideline

No hard cap. Maintain via entry lifecycle.

## Entry Format

```markdown
### [Preference]
- **Date observed:** YYYY-MM-DD
- **Applies to:** all | [specific context]
- **Importance:** 1-5 (1=critical, 5=minor)
- **Type:** procedural | experiential
```

See `examples/preferences.md` for a full example.

## Rules

1. Must be a standing instruction, not a one-time request. One-time
   requests are session events, not preferences.
2. Per-user preferences go in `users/<id>/profile.md`, not here.
3. NOT preferences: decisions with alternatives considered (-> decisions.md),
   workflow ideas (-> ideas.md).
4. "Applies to: all" means every interaction. Specify context if limited
   (e.g., "Telegram messages only").
