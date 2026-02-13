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

### Step 4: Set Up PATH for Bin Commands

If the JSON output includes `skill.bin` entries (component provides CLI commands), `~/zylos/bin` must be in PATH. Since each shell command runs in a separate process, **prefix all subsequent commands** that use component CLIs with the PATH export:

```bash
export PATH="$HOME/zylos/bin:$PATH" && <command>
```

### Step 5: Execute Post-Install Hook

If `skill.hooks.post-install` exists in the JSON output, run it. If Step 4 applied (component has bin), include the PATH prefix:

```bash
export PATH="$HOME/zylos/bin:$PATH" && node ~/zylos/.claude/skills/<component>/hooks/post-install.js
```

Set environment variables: `ZYLOS_COMPONENT`, `ZYLOS_SKILL_DIR`, `ZYLOS_DATA_DIR`.
If the hook fails, investigate and fix the issue.

### Step 6: Start Service and Guide User

1. If component has `skill.service`, start it: `pm2 start ecosystem.config.cjs` (or entry point) and verify health
2. Show the `skill.nextSteps` from JSON output to guide user on what to do next
3. Confirm successful installation

## C4 Mode

C4 install uses a two-step confirmation flow (same as upgrade/uninstall).

### Step 1: Preview Component Info

When user says "add \<name\>", run:
```bash
zylos add <name> --check --json
```

This resolves the target and outputs component info (name, version, description, type, repo) without installing. Show the info to the user and ask for confirmation.

### Step 2: Install After Confirmation

When user says "add \<name\> confirm", run:
```bash
zylos add <name> --json
```

### Post-Install Actions

After `zylos add <name> --json` succeeds, the JSON `skill` field tells you what to do:

1. **Bin PATH**: If `skill.bin` exists, prefix all subsequent commands with `export PATH="$HOME/zylos/bin:$PATH" && `.
2. **Config**: If `skill.config.required` exists, inform user which config values are needed. In C4 mode, user provides values via follow-up messages.
3. **Hooks**: If `skill.hooks.post-install` exists, run it (with PATH prefix if step 1 applied).
4. **Service**: If `skill.service` exists, start it and verify.
5. **Next Steps**: If `skill.nextSteps` exists, follow the instructions — this typically includes post-service-start guidance (e.g., configuring webhook URLs, optional security settings). Always show these to the user.
6. **SKILL.md**: If the component's SKILL.md has additional setup documentation beyond the frontmatter, read and follow it for any remaining configuration steps.
