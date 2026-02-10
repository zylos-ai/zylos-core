# Install Workflow

## Session Mode

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

## C4 Mode

C4 install uses `zylos add <name> --yes --json` directly (no pre-confirmation needed for install).

### Post-Install Actions

After `zylos add <name> --yes --json` succeeds, the JSON `skill` field tells you what to do:

1. **Config**: If `skill.config.required` exists, inform user which config values are needed. In C4 mode, user provides values via follow-up messages.
2. **Hooks**: If `skill.hooks.post-install` exists, run it.
3. **Service**: If `skill.service` exists, start it and verify.
