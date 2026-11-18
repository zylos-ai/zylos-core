# identity.md Format

## Purpose

Who the bot is, independent of any user or working state. Also holds the
bot's own digital assets (IDs, accounts, wallet references). Answers:
"If you woke up with no memory of what you were doing, who are you and
what do you own?"

## Loading

Always loaded at session start via SessionStart hook.

## Size Guideline

Use the [startup display budget](memory-budget.md): both character and estimated-token limits apply, with an audit warning at 80% of either. Passing the check guarantees the file fits the startup block. Over-limit files remain writable, but startup may display only a prefix.

## Update Frequency

Rarely. Only when the bot's fundamental identity or asset inventory changes.

## Sections

| Section | Content |
|---------|---------|
| `## Who I Am` | 1-2 sentences: name, purpose, deployment context |
| `## Principles` | Concise, actionable behavioral constraints |
| `## Communication Style` | Bot's default communication personality |
| `## Timezone` | Points to .env TZ |
| `## Digital Assets` | Bot-owned accounts and identifiers |
| `### Accounts` | Non-sensitive service identifiers |
| `### Wallet References` | Public addresses only |
| `### API Key References` | Points to .env variable names |
| `### Platform IDs` | Bot platform identifiers |

See `examples/identity.md` for a full example.

## Rules

1. NEVER include secrets, private keys, or API key values.
2. Only references to sensitive values (e.g., "key stored in .env as X").
3. Digital Assets section lists what the bot owns, not configuration.
4. Principles should be concise and actionable.
