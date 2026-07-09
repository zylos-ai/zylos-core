# references.md Format

## Purpose

A lookup table that points to configuration sources rather than duplicating
their values. Prevents drift between references.md and the actual config files.

## Loading

Always loaded at session start via SessionStart hook.

## Size Guideline

Target ≤8KB (warn threshold, reported as WARN by `memory-status.js`);
hard budget 16KB. Pointer/index only, not prose. A healthy instance core
is ~4-5KB — sustained growth past the warn threshold means narrative
content is leaking in and the content rules below are being violated.

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

## Content Rules

### Allowed

- Stable identifiers: bot/app/member IDs, account handles
- Endpoints, ports, domains, webhook routes
- Key paths (memory, skills, data directories)
- Active policy pointers: `dmPolicy=owner, see config.json`
- Pointers to source-of-truth files (`.env`, `config.json`, registries)

### Disallowed — route instead of appending

| Content class | Route to |
|---------------|----------|
| Version/upgrade history, breaking-change notes | `reference/decisions.md` |
| Incident caveats, lessons learned | `reference/decisions.md` |
| Entries for uninstalled/dead components | `archive/` |
| Values already present in a config file | replace with a pointer |

### Rules

1. NEVER duplicate a value that exists in `.env` or another config file.
2. Point to the source instead:
   - Instead of `TZ: Asia/Shanghai`, write `TZ: see .env`
   - Instead of listing API keys, write `API keys: see .env`
3. Keep entries as terse pointers, not explanations. One line per entry;
   no narrative sentences attached to identifiers.
4. Active IDs section is for IDs needed in current context only.
5. Memory Sync audits this file against these rules on every sync
   (see SKILL.md Sync Flow): violations are relocated, not left in place.
