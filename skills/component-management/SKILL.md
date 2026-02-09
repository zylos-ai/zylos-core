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
5. **CLI = mechanical, Claude = intelligent** - CLI handles downloads, backups, file sync. Claude handles config, hooks, service management, user interaction.

## Install Workflow

When user asks to install a component:

**If component is already installed, inform user and suggest using upgrade instead.**

### Step 1: Show Component Info and Confirm

```
Found <component> component:
- <name>@<version>: <description>

Proceed with installation?
```

### Step 2: Execute CLI Installation

After user confirms, run:
```bash
zylos add <component> --yes --json
```

The CLI handles: download, npm install, manifest generation, component registration.
The JSON output includes `skill` field with hooks, config schema, and service info.

### Step 3: Collect Configuration

Read the `skill.config` from the JSON output (or the installed SKILL.md).

**If no config.required AND no config.optional exists, skip to Step 4.**

For each required config item, ask user to provide the value:

```
Please provide API_KEY (Your API key):
```

For sensitive values, remind user it will be stored securely.
Write collected values to `~/zylos/.env`.

### Step 4: Execute Post-Install Hook

If `skill.hooks.post-install` exists in the JSON output, run it:

```bash
node ~/zylos/.claude/skills/<component>/hooks/post-install.js
```

Set environment variables: `ZYLOS_COMPONENT`, `ZYLOS_SKILL_DIR`, `ZYLOS_DATA_DIR`.
If the hook fails, investigate and fix the issue.

### Step 5: Start Service and Guide User

1. If component has `skill.service`, start it: `pm2 start ecosystem.config.cjs` (or entry point) and verify health
2. Show the `skill.nextSteps` from JSON output to guide user on what to do next
3. Confirm successful installation

## Upgrade Workflow

When user asks to upgrade a component:

**If component is not installed, inform user and suggest using add instead.**

### Step 1: Check Available Updates

```bash
zylos upgrade <component> --check --json
```

This shows: current version, available version, changelog, local changes.

**If already at latest version, inform user and stop.**

### Step 2: Analyze Changes and Confirm

**Always actively analyze what changed between versions.** Don't just relay changelog text.

1. Read the `changelog` from JSON output (if present)
2. Fetch commit history between current and latest versions via `gh api` or the component's git log
3. Synthesize a clear summary of what changed and why — changelog is one input, not the sole source
4. Present the analysis and ask for confirmation

### Step 3: Execute Pre-Upgrade Hook

**Before calling CLI**, check if the component has a `hooks/pre-upgrade.js`:

```bash
node ~/zylos/.claude/skills/<component>/hooks/pre-upgrade.js
```

Set environment variables: `ZYLOS_COMPONENT`, `ZYLOS_SKILL_DIR`, `ZYLOS_DATA_DIR`.
If the hook fails (exit code 1), **abort the upgrade** and inform user.

### Step 4: Execute CLI Upgrade

Only after pre-upgrade hook succeeds (or doesn't exist):

```bash
zylos upgrade <component> --yes --skip-eval --json
```

The CLI handles: stop service, backup, file sync, npm install, manifest.
The JSON output includes `skill` field with updated hooks, config, and service info.

### Step 5: Execute Post-Upgrade Hook

If `skill.hooks.post-upgrade` exists in the JSON output, run it:

```bash
node ~/zylos/.claude/skills/<component>/hooks/post-upgrade.js
```

This typically handles config migration. If it fails, investigate.

### Step 6: Start Service and Check Config

1. Restart the service: `pm2 restart <service-name>` (or start fresh if not registered)
2. Verify the service is healthy
3. Compare old and new SKILL.md config — if new required config items were added, collect them interactively

## Self-Upgrade Workflow (zylos-core)

### Step 1: Check and Confirm

```bash
zylos upgrade --self --check --json
```

Actively analyze what changed (changelog + commits), show version change + change summary. Get user confirmation.

### Step 2: Execute CLI Self-Upgrade

```bash
zylos upgrade --self --yes --json
```

The CLI handles: backup, npm install -g, sync Core Skills, sync CLAUDE.md, restart PM2 services, verify.
The JSON output includes a `templates` field listing template files.

### Step 3: Compare Templates and Migrate

Read the `templates` array from JSON output. Compare each template path with the local file structure.
If templates include new files (e.g., `.claude/hooks/`, `memory/` structure), deploy or migrate them.

### Step 4: Restart Claude (If Needed)

If the upgrade changed hooks or skills, execute `restart-claude` to load new configuration.

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

### Step 2: Pre-Uninstall Cleanup

Before executing CLI uninstall, check the component's SKILL.md for external resources that need cleanup:
- Webhook registrations (deregister)
- Active connections (close gracefully)
- External service integrations (notify/cleanup)

### Step 3: Execute Uninstall

After user chooses:
```bash
# Option 1: Code only (default)
zylos uninstall <component> --yes --json

# Option 2: Including data
zylos uninstall <component> --purge --yes --json
```

### Step 4: Clean Environment Variables

Remove the component's declared environment variables from `~/zylos/.env` to avoid stale credentials.

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

All `--json` outputs include structured data and a `reply` field (pre-formatted fallback).

**Preferred**: Use the JSON data fields to craft a clear, user-friendly plain text reply.
**Fallback**: If you're unsure how to format the reply, use the `reply` field directly.

The `reply` field ensures correctness even if this SKILL.md is outdated, but you can always
improve on it by writing a more natural reply based on the JSON data.

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
| add \<name\> | `zylos add <name> --yes --json` |
| upgrade zylos | `zylos upgrade --self --check --json` **(CHECK ONLY)** |
| upgrade zylos confirm | `zylos upgrade --self --yes --json` **(only this executes)** |
| uninstall \<name\> / remove \<name\> | `zylos uninstall <name> --check --json` **(CHECK ONLY — preview what will be removed)** |
| uninstall \<name\> confirm | `zylos uninstall <name> confirm --json` **(uninstall, keep data)** |
| uninstall \<name\> purge | `zylos uninstall <name> purge --json` **(uninstall and delete all data)** |

### C4 Post-Install Actions

After `zylos add <name> --yes --json` succeeds, the JSON `skill` field tells you what to do:

1. **Config**: If `skill.config.required` exists, inform user which config values are needed. In C4 mode, user provides values via follow-up messages.
2. **Hooks**: If `skill.hooks.post-install` exists, run it.
3. **Service**: If `skill.service` exists, start it and verify.

### C4 Post-Upgrade Actions

After `zylos upgrade <name> --yes --skip-eval --json` succeeds:

1. **Hooks**: If `skill.hooks.post-upgrade` exists, run it.
2. **Service**: If `skill.service` exists, restart and verify.
3. **Config**: If new config items added, inform user.

Reply with version change, change summary, and any action results.

### C4 Upgrade Confirm Flow

**Upgrades ALWAYS use two-step confirmation. NEVER skip step 1 and go directly to step 2.**
**Even if the user says "帮我升级", "please upgrade", or any variation — always do step 1 first.**

**Step 1 — User requests upgrade:**

User: `upgrade telegram`

Run `zylos upgrade telegram --check --json`, parse the JSON output, then **actively analyze what changed**:

1. Read the `changelog` field from JSON output (if present)
2. Fetch commit history: `gh api repos/zylos-ai/zylos-<component>/compare/v<current>...v<latest> --jq '.commits[].commit.message'` (with proxy)
3. Synthesize a clear change summary from both sources — explain what changed and why, don't just copy changelog text

Reply with ALL of the following:
1. Version change: `<name>: <current> -> <latest>`
2. Change summary: your synthesized analysis of what changed (using changelog + commits)
3. Local changes: show if any, or "none"
4. Confirm instruction

**You MUST analyze and explain what changed. Do NOT just show version numbers and ask to confirm.**

Example reply:
```
telegram: 0.1.0 -> 0.2.0

Changes:
- Fixed dotenv path resolution that caused config loading failures
- Added admin CLI for managing groups and whitelist directly

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

1. Run pre-upgrade hook if it exists (check SKILL.md hooks)
2. Run `zylos upgrade telegram --yes --skip-eval --json`
3. Run post-upgrade hook if `skill.hooks.post-upgrade` exists in result
4. Restart service if `skill.service` exists in result
5. Reply with version change and change summary

If the upgrade failed, report the error and rollback status from JSON.

### C4 Self-Upgrade Flow (zylos-core)

Same two-step pattern for upgrading zylos itself.

**Step 1 — User requests:**

User: `upgrade zylos`

Run `zylos upgrade --self --check --json`, then **actively analyze what changed**:

1. Read the `changelog` field from JSON output (if present)
2. Fetch commit history: `gh api repos/zylos-ai/zylos-core/compare/v<current>...v<latest> --jq '.commits[].commit.message'` (with proxy)
3. Synthesize a clear change summary from both sources

Reply with version change and your analysis:

```
zylos-core: 0.1.0-beta.1 -> 0.1.0-beta.2

Changes:
- Added self-upgrade support for IM channels (Telegram, Lark)
- Fixed version detection that failed on pre-release tags

Reply "upgrade zylos confirm" to proceed.
```

If already up to date, reply: `zylos-core is up to date (v0.1.0-beta.1)`

**Step 2 — User confirms:**

User: `upgrade zylos confirm`

1. Run `zylos upgrade --self --yes --json`
2. Compare `templates` list from JSON with local structure, migrate if needed
3. If hooks/skills changed, execute restart-claude
4. Reply with version change and change summary

### C4 Uninstall Confirm Flow

Same two-step pattern as upgrades. User chooses whether to keep or delete data.

**Step 1 — User requests uninstall:**

User: `uninstall lark` or `remove lark`

Run `zylos uninstall lark --check --json`. The JSON output includes component info, service name, data directory path, and dependents. Present the preview and offer two options:
- `uninstall <name> confirm` — uninstall but keep data
- `uninstall <name> purge` — uninstall and delete all data

**Step 2 — User chooses:**

User: `uninstall lark confirm` (keep data) or `uninstall lark purge` (delete all)

1. Check SKILL.md for external cleanup needs (webhooks, connections)
2. Run `zylos uninstall lark confirm --json` or `zylos uninstall lark purge --json`
3. Clean component's environment variables from .env
4. Reply with result

### C4 Output Formatting

**NOTE: Prefer crafting replies from JSON data (see "C4 Reply Formatting" above). The `reply` field and rules below serve as reference.**

- Plain text only, no markdown
- For `info --json`: format as `<name> v<version>\nType: <type>\nRepo: <repo>\nService: <name> (<status>)`
- For `check --json`: format as `<name>: <current> -> <latest>`, **actively analyze changes** (changelog + commit history), warn about `localChanges` if present, show `evaluation` analysis if present
- For `--self --check --json`: same as component check, but target is `zylos-core` instead of component name
- For upgrade result (`--yes --json`): format as `<name> upgraded: <from> → <to>`, include change summary
- For errors: when JSON has both `error` and `message` fields, display `message` (human-readable)
- Send reply via the appropriate channel's send script

### C4 Differences from Session Mode

| Aspect | Claude Session | C4 |
|--------|---------------|-----|
| Confirmation | Interactive dialog | Two-step: preview + "confirm" command |
| Output format | Rich (emoji, formatting) | Plain text only |
| Config collection | Interactive prompts | User provides via follow-up messages |
| Remove/uninstall | Supported (with data options) | Two-step: preview + "confirm" or "purge" |
| Upgrade eval | Claude evaluation runs | Skipped (--skip-eval) |
