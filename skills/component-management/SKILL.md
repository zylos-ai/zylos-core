---
name: component-management
description: Guidelines for managing zylos components via CLI and C4 channels. Use when installing, upgrading, or uninstalling components, or when user asks about available components.
---

# Component Management

Guidelines for installing, upgrading, and managing zylos components.

## CLI

`zylos` is a **global npm command** (installed via `npm install -g zylos`).
Run it directly as `zylos`, NOT as `~/zylos/zylos` or `./zylos`.

## General Principles

1. **Always confirm before executing** - User must explicitly approve install/upgrade/uninstall
2. **Guide interactively** - Never just tell user to "manually edit files"
3. **Read SKILL.md** - Each component declares its requirements in SKILL.md frontmatter
4. **Detect execution mode** - Handle both Claude session and C4 channels differently
5. **CLI = mechanical, Claude = intelligent** - CLI handles downloads, backups, file sync. Claude handles config, hooks, service management, user interaction.

## Workflows

Detailed step-by-step workflows for each operation (Session + C4 modes):

- **[Install](references/install.md)** — Add new components
- **[Upgrade](references/upgrade.md)** — Upgrade components and zylos-core (self-upgrade)
- **[Uninstall](references/uninstall.md)** — Remove components with data options

## Quick Commands

```bash
# List installed components
zylos list

# Search available components
zylos search <keyword>

# Component status
zylos status

# Check all components for updates
zylos upgrade --all --check
```

## SKILL.md Config Format

Components declare their configuration requirements in SKILL.md frontmatter:

```yaml
---
name: my-component
version: 1.0.0
description: Component description

config:
  required:
    - name: ENV_VAR_NAME
      description: Human-readable description
      sensitive: true  # Optional: marks as secret
  optional:
    - name: OPTIONAL_VAR
      description: Optional setting
      default: "default-value"
---
```

When `sensitive: true`, the value should be handled carefully (not logged, stored in .env).

---

## C4 Mode (IM Channels)

When user sends requests via C4 comm-bridge (Telegram, Lark, etc.), use streamlined flows with two-step confirmation. Replies must be plain text (no markdown).

### Detecting C4 Mode

The request is from C4 when the message arrives via a communication channel
(e.g., `<user> said: ...` with a `reply via:` instruction).

### C4 Reply Formatting

All `--json` outputs include structured data and a `reply` field (pre-formatted fallback).

**Preferred**: Use the JSON data fields to craft a clear, user-friendly plain text reply.
**Fallback**: If you're unsure how to format the reply, use the `reply` field directly.

### C4 Command Mapping

**CRITICAL: "upgrade \<name\>" MUST ONLY run --check. NEVER execute the actual upgrade without the word "confirm" in the user's message.**

| User says | CLI command |
|-----------|------------|
| list / list components | `zylos list` |
| info \<name\> | `zylos info <name> --json` |
| check / check updates | `zylos upgrade --all --check --json` |
| check \<name\> | `zylos upgrade <name> --check --json` |
| upgrade \<name\> | `zylos upgrade <name> --check --json` **(CHECK ONLY)** |
| upgrade \<name\> confirm | `zylos upgrade <name> --yes --skip-eval --json --temp-dir <tempDir>` |
| add \<name\> | `zylos add <name> --check --json` **(CHECK ONLY)** |
| add \<name\> confirm | `zylos add <name> --json` |
| upgrade zylos | `zylos upgrade --self --check --json` **(CHECK ONLY)** |
| upgrade zylos confirm | `zylos upgrade --self --yes --json --temp-dir <tempDir>` |
| uninstall \<name\> | `zylos uninstall <name> --check --json` **(CHECK ONLY)** |
| uninstall \<name\> confirm | `zylos uninstall <name> confirm --json` |
| uninstall \<name\> purge | `zylos uninstall <name> purge --json` |

### C4 Output Formatting

- Plain text only, no markdown
- For `info --json`: format as `<name> v<version>\nType: <type>\nRepo: <repo>\nService: <name> (<status>)`
- For `check --json`: format as `<name>: <current> -> <latest>`, actively analyze changes
- For upgrade result: format as `<name> upgraded: <from> -> <to>`, include change summary
- For errors: when JSON has both `error` and `message` fields, display `message` (human-readable)

### C4 vs Session Differences

| Aspect | Claude Session | C4 |
|--------|---------------|-----|
| Confirmation | Interactive dialog | Two-step: preview + "confirm" command |
| Output format | Rich (emoji, formatting) | Plain text only |
| Config collection | Interactive prompts | User provides via follow-up messages |
| Upgrade eval | Claude evaluation runs | Skipped (--skip-eval) |
