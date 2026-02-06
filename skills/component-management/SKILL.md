---
name: component-management
description: Guidelines for managing zylos components via CLI and IM (Telegram/Lark).
---

# Component Management

Guidelines for installing, upgrading, and managing zylos components.

## General Principles

1. **Always confirm before executing** - User must explicitly approve install/upgrade/uninstall
2. **Guide interactively** - Never just tell user to "manually edit files"
3. **Read SKILL.md** - Each component declares its requirements in SKILL.md frontmatter
4. **Detect execution mode** - Handle both Claude session and IM (Telegram/Lark) differently

## Install Workflow

When user asks to install a component:

**If component is already installed, inform user and suggest using upgrade instead.**

### Step 1: Show Component Info and Confirm

```
Found <component> component:
- <name>@<version>: <description>

Proceed with installation?
```

### Step 2: Execute Installation

After user confirms, run:
```bash
zylos add <component>
```

### Step 3: Check for Configuration

Read the installed component's SKILL.md at `~/zylos/.claude/skills/<component>/SKILL.md`.
Look for the `config.required` section in frontmatter.

**If no config.required AND no config.optional exists, skip to Step 5.**

```yaml
config:
  required:
    - name: API_KEY
      description: Your API key
    - name: API_SECRET
      description: Your API secret
      sensitive: true
```

### Step 4: Collect Configuration Interactively

For each required config item, ask user to provide the value:

```
Please provide API_KEY (Your API key):
```

For sensitive values, remind user it will be stored securely.

For optional config items, show the default value and ask if user wants to change it:

```
OPTIONAL_VAR (Optional setting) [default: "default-value"]:
```

User can press Enter to use default, or provide a custom value.

### Step 5: Write Config and Start Service

1. If config was collected, write values to `~/zylos/.env`
2. If component has `lifecycle.service.name`, restart the service: `pm2 restart <service-name>`
3. Confirm successful startup (or installation complete if no service)

## Upgrade Workflow

When user asks to upgrade a component:

**If component is not installed, inform user and suggest using install instead.**

### Step 1: Check Available Updates

```bash
zylos upgrade <component> --check
```

This shows:
- Current version
- Available version
- Changelog summary
- Local changes (if any)

**If already at latest version, inform user and stop. No further steps needed.**

### Step 2: Show User and Confirm

Present the upgrade info to user and ask for confirmation:

```
Upgrade available for <component>:
- Current: 0.1.0
- Latest: 0.2.0

Changelog:
- Added feature X
- Fixed bug Y

Proceed with upgrade?
```

### Step 3: Execute Upgrade

Only after user explicitly confirms:
```bash
zylos upgrade <component> --yes
```

**NEVER skip the confirmation step.** User must explicitly agree before upgrade executes.

### Step 4: Check for New Configuration

After upgrade completes, re-read the component's SKILL.md.
If the new version added new `config.required` or `config.optional` items, collect them interactively (same as Install Step 4-5).

## Uninstall Workflow

When user asks to uninstall a component:

**If component is not installed, inform user and stop.**

### Step 1: Confirm and Ask About Data

```
Uninstall <component>?

Choose an option:
1. Remove code only (keep data in ~/zylos/components/<component>/)
2. Remove everything (code + data)
```

### Step 2: Execute Uninstall

After user chooses:
```bash
# Option 1: Code only (default)
zylos uninstall <component>

# Option 2: Including data
zylos uninstall <component> --purge
```

## Check for Updates (All Components)

```bash
zylos upgrade --all --check
```

Lists all components with available updates.

## Other Commands

```bash
# List installed components
zylos list

# Search available components
zylos search <keyword>

# Component status
zylos status
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

## IM Mode (Telegram / Lark)

When user sends component management requests via IM (Telegram/Lark), use a streamlined flow.
IM messages arrive via send-reply.sh. Replies must be plain text (no markdown).

### Detecting IM Mode

The request is from IM when the message arrives via Telegram bot or Lark agent
(e.g., `howardzhou said: ...` or `Hongyun said: ...`).

### IM Command Mapping

| User says | CLI command |
|-----------|------------|
| list / list components | `zylos list` |
| info \<name\> | `zylos info <name> --json` |
| check / check updates | `zylos upgrade --all --check --json` |
| check \<name\> | `zylos upgrade <name> --check --json` |
| upgrade \<name\> | `zylos upgrade <name> --check --json` (preview only) |
| upgrade \<name\> confirm | `zylos upgrade <name> --yes --skip-eval` |
| add \<name\> | `zylos add <name> --yes` |
| remove / uninstall | Reject — reply: "Remove is not supported via IM. Use CLI directly." |

### IM Upgrade Confirm Flow

Upgrades use two-step confirmation. No state is stored between messages.

**Step 1 — User requests upgrade:**

User: `upgrade telegram`

Run `zylos upgrade telegram --check --json`, format the JSON, and reply:

```
telegram: 0.1.0 -> 0.2.0

Changelog:
- Fixed dotenv path issue

Reply "upgrade telegram confirm" to proceed.
```

**Step 2 — User confirms:**

User: `upgrade telegram confirm`

Run `zylos upgrade telegram --yes --skip-eval` and reply with the output.

The confirm command is self-contained — the component name is in the command itself,
so it does not depend on Claude remembering the previous message.

### IM Output Formatting

When formatting `--json` output for IM replies:

- Plain text only, no markdown
- For `info --json`: format as `<name> v<version>\nType: <type>\nRepo: <repo>\nService: <name> (<status>)`
- For `check --json`: format as `<name>: <current> -> <latest>` or `<name> is up to date (v<current>)`
- For errors: when JSON has both `error` and `message` fields, display `message` (human-readable)
- Send reply via the appropriate channel's send script

### IM Differences from Session Mode

| Aspect | Claude Session | IM |
|--------|---------------|-----|
| Confirmation | Interactive dialog | Two-step: preview + "confirm" command |
| Output format | Rich (emoji, formatting) | Plain text only |
| Config collection | Interactive prompts | Skip (use --yes), configure later |
| Remove/uninstall | Supported | Rejected (too dangerous) |
| Upgrade eval | Claude evaluation runs | Skipped (--skip-eval) |
