---
name: component-management
description: Guidelines for managing zylos components via CLI and C4 channels.
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

**If component is not installed, inform user and suggest using add instead.**

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

## C4 Mode (IM Channels)

When user sends component management requests via C4 comm-bridge (Telegram, Lark, or any connected channel), use a streamlined flow. Replies must be plain text (no markdown).

### Detecting C4 Mode

The request is from C4 when the message arrives via a communication channel
(e.g., `<user> said: ...` with a `reply via:` instruction).

### C4 Reply Formatting

**All `--json` outputs include a `reply` field with a pre-formatted plain text reply.**
**When the JSON output has a `reply` field, use it directly as the C4 reply.**
This ensures the reply format is always correct regardless of SKILL.md version.

### C4 Command Mapping

**CRITICAL: "upgrade \<name\>" MUST ONLY run --check. NEVER execute the actual upgrade without the word "confirm" in the user's message.**

| User says | CLI command |
|-----------|------------|
| list / list components | `zylos list` |
| info \<name\> | `zylos info <name> --json` |
| check / check updates | `zylos upgrade --all --check --json` |
| check \<name\> | `zylos upgrade <name> --check --json` |
| upgrade \<name\> | `zylos upgrade <name> --check --json` **(CHECK ONLY — do NOT execute upgrade)** |
| upgrade \<name\> confirm | `zylos upgrade <name> --yes --skip-eval --json` **(only this executes the upgrade)** |
| add \<name\> | `zylos add <name> --yes` |
| upgrade zylos | `zylos upgrade --self --check --json` **(CHECK ONLY)** |
| upgrade zylos confirm | `zylos upgrade --self --yes --json` **(only this executes)** |
| remove / uninstall | Reject — reply: "Remove is not supported via C4. Use CLI directly." |

### C4 Upgrade Confirm Flow

**Upgrades ALWAYS use two-step confirmation. NEVER skip step 1 and go directly to step 2.**
**Even if the user says "帮我升级", "please upgrade", or any variation — always do step 1 first.**

**Step 1 — User requests upgrade:**

User: `upgrade telegram`

Run `zylos upgrade telegram --check --json`, parse the JSON output, and reply with ALL of the following:

1. Version change: `<name>: <current> -> <latest>`
2. Changelog: MUST include the full changelog from the JSON output
3. Local changes: show if any, or "none"
4. Confirm instruction

**You MUST show the changelog. Do NOT just show version numbers and ask to confirm.**

Example reply:
```
telegram: 0.1.0 -> 0.2.0

Changelog:
- Fixed dotenv path issue
- Added admin CLI

Local changes: none

Reply "upgrade telegram confirm" to proceed.
```

If there are local modifications, show them with Claude's analysis:
```
telegram: 0.1.0 -> 0.2.0

Changelog:
- Fixed dotenv path issue

WARNING: Local modifications detected:
  M src/bot.js
  A custom-plugin.js

Upgrade analysis:
  src/bot.js: safe - changes are in config section, upgrade won't overwrite
  custom-plugin.js: safe - new file, preserved by lifecycle.preserve

Recommendation: Safe to upgrade.

Reply "upgrade telegram confirm" to proceed.
```

The `evaluation` field in JSON contains `files` (array of `{file, verdict, reason}`) and `recommendation`.

**Step 2 — User confirms:**

User: `upgrade telegram confirm`

Run `zylos upgrade telegram --yes --skip-eval --json`, parse the JSON output, and reply:

```
<name> upgraded: <from> → <to>

Changelog:
<changelog from JSON output>
```

Include the `changelog` field from JSON in the completion message so the user knows what changed.
If the upgrade failed, report the error and rollback status from JSON.

The confirm command is self-contained — the component name is in the command itself,
so it does not depend on Claude remembering the previous message.

### C4 Self-Upgrade Flow (zylos-core)

Same two-step pattern for upgrading zylos itself.

**Step 1 — User requests:**

User: `upgrade zylos`

Run `zylos upgrade --self --check --json`, format the JSON, and reply:

```
zylos-core: 0.1.0-beta.1 -> 0.1.0-beta.2

Changelog:
- Added self-upgrade support for IM channels
- Fixed version detection

Reply "upgrade zylos confirm" to proceed.
```

If already up to date, reply: `zylos-core is up to date (v0.1.0-beta.1)`

**Step 2 — User confirms:**

User: `upgrade zylos confirm`

Run `zylos upgrade --self --yes --json`, parse the JSON output, and reply with the version change and changelog (same format as component upgrade completion).

### C4 Output Formatting

**NOTE: As of v0.1.0-beta.13, use the `reply` field from JSON output directly (see "C4 Reply Formatting" above). The rules below are kept as fallback reference only.**

- Plain text only, no markdown
- For `info --json`: format as `<name> v<version>\nType: <type>\nRepo: <repo>\nService: <name> (<status>)`
- For `check --json`: format as `<name>: <current> -> <latest>`, include `changelog` field if present, warn about `localChanges` if present, show `evaluation` analysis if present
- For `--self --check --json`: same as component check, but target is `zylos-core` instead of component name
- For upgrade result (`--yes --json`): format as `<name> upgraded: <from> → <to>`, include `changelog` field if present
- For errors: when JSON has both `error` and `message` fields, display `message` (human-readable)
- Send reply via the appropriate channel's send script

### C4 Differences from Session Mode

| Aspect | Claude Session | C4 |
|--------|---------------|-----|
| Confirmation | Interactive dialog | Two-step: preview + "confirm" command |
| Output format | Rich (emoji, formatting) | Plain text only |
| Config collection | Interactive prompts | Skip (use --yes), configure later |
| Remove/uninstall | Supported | Rejected (too dangerous) |
| Upgrade eval | Claude evaluation runs | Skipped (--skip-eval) |
