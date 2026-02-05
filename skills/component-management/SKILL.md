---
name: component-management
version: 1.0.0
description: Guidelines for managing zylos components
type: internal
---

# Component Management

Guidelines for installing, upgrading, and managing zylos components.

## General Principles

1. **Always confirm before executing** - User must explicitly approve install/upgrade/uninstall
2. **Guide interactively** - Never just tell user to "manually edit files"
3. **Read SKILL.md** - Each component declares its requirements in SKILL.md frontmatter

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
zylos install <component>
```

### Step 3: Check for Required Configuration

Read the installed component's SKILL.md at `~/.claude/skills/<component>/SKILL.md`.
Look for the `config.required` section in frontmatter.

**If no config.required exists, skip to Step 5.**

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

### Step 5: Write Config and Start Service

1. If config was collected, write values to `~/zylos/.env`
2. If component has `lifecycle.service.name`, restart the service: `pm2 restart <service-name>`
3. Confirm successful startup (or installation complete if no service)

## Upgrade Workflow

When user asks to upgrade a component:

### Step 1: Check Available Updates

```bash
zylos upgrade <component> --check
```

This shows:
- Current version
- Available version
- Changelog summary
- Local changes (if any)

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
If the new version added new `config.required` items, collect them interactively (same as Install Step 4-5).

## Uninstall Workflow

When user asks to uninstall a component:

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
