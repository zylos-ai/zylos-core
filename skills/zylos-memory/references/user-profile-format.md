# User Profile Format

## Purpose

Per-user preferences, communication style, and notes. Each user has their
own file at `users/<id>/profile.md`.

## Loading

On demand, when the bot receives a message from this user or needs their
preferences.

## Size Guideline

~1KB per user.

## Update Frequency

When a user states a preference or the bot learns something about the user.

## Sections

| Section | Content |
|---------|---------|
| `## Identity` | Name, user ID, primary channel |
| `## Communication` | Language preference, response style, special instructions |
| `## Preferences` | Key user-specific preferences |
| `## Notes` | Anything else learned about this user |
| `Last updated` | YYYY-MM-DD timestamp |

See `examples/user-profile.md` for a full example.

## Rules

1. User-specific data goes here, not in `reference/preferences.md`.
2. Per-user vs shared: if a preference applies to one user only, it goes
   in their profile. If it applies to all interactions, use `preferences.md`.
3. Do not store sensitive user data (passwords, tokens).
4. Keep notes concise and actionable.
