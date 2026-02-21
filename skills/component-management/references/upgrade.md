# Upgrade Workflow

## Smart Merge

Upgrades use **smart merge** — a three-way merge strategy that replaces the old preserve-or-overwrite approach. Every file gets a definitive outcome:

| Outcome | Condition | Action |
|---------|-----------|--------|
| **overwrite** | Local unmodified | New version applied directly |
| **keep** | Only local modified, new version unchanged | Local version preserved |
| **merged** | Both changed different sections | diff3 produces clean merge |
| **conflict** | Both changed same section, or no merge base | New version wins, local backed up |
| **added** | File is new in this version | Copied to installed dir |
| **deleted** | File removed in new version | Deleted from installed dir (user-added files preserved) |

### Conflict Handling

When a conflict occurs:
1. The **new version** is written to the installed location (ensures upgrade completeness)
2. The **local version** is backed up to `.backup/<timestamp>/conflicts/<path>`
3. The upgrade result includes `mergeConflicts` listing each conflict with its backup path

### Merge Review (Conversation Mode)

After upgrade, if `mergeConflicts` is non-empty, Claude should:

1. Read each conflict's backup file and the newly installed version
2. Understand what the local modification was trying to achieve
3. Re-apply the local changes intelligently using Edit tool
4. Verify the result (syntax check, import check if applicable)

This is where AI merge adds real value — Claude has full context, tools, and can verify.

### Merge Review (CLI Mode)

In CLI mode (`zylos upgrade`), conflicts are reported with backup paths. The user is prompted:
> "X files had local modifications that conflicted with the upgrade. Backups saved to /path/to/backup. Start a Claude session and run merge-review to re-apply your changes."

## Session Mode — Component Upgrade

When user asks to upgrade a component:

**If component is not installed, inform user and suggest using add instead.**

### Step 1: Check + Download to Temp

```bash
zylos upgrade <component> --check --json
```

The CLI checks for updates **and downloads the new version to a temporary directory** when an update is available. JSON output includes:
- `current`, `latest`, `hasUpdate` — version info
- `changelog` — filtered changelog text
- `localChanges` — local modifications detected against manifest
- `tempDir` — path to downloaded package (for file comparison)

**If already at latest version, inform user and stop.**

### Step 2: Analyze Changes, Compare Files, and Confirm

**All information must be presented BEFORE asking for confirmation.** No surprises after execution.

1. **Analyze changes**: Read `changelog` from JSON + fetch commit history via `gh api`. Synthesize a clear summary — don't just relay changelog text.
2. **Compare files**: Read files from `tempDir`, compare with installed files in the skill directory:
   - **New files**: list them
   - **Changed files**: show differences for user awareness
   - **Unchanged files**: skip
3. **Present everything** to user and ask for confirmation

### Step 3: Execute Pre-Upgrade Hook

**Before calling CLI**, check if the component has a `hooks/pre-upgrade.js`:

```bash
node ~/zylos/.claude/skills/<component>/hooks/pre-upgrade.js
```

Set environment variables: `ZYLOS_COMPONENT`, `ZYLOS_SKILL_DIR`, `ZYLOS_DATA_DIR`.
If the hook fails (exit code 1), **abort the upgrade** and inform user.

### Step 4: Execute CLI Upgrade

Only after pre-upgrade hook succeeds (or doesn't exist). **Reuse the temp dir from Step 1**:

```bash
zylos upgrade <component> --yes --skip-eval --json --temp-dir <tempDir>
```

The CLI handles: stop service, backup, smart merge from tempDir, npm install, manifest, **cleanup tempDir**.
The JSON output includes:
- `skill` field with updated hooks, config, and service info
- `mergeConflicts` — files where local was backed up (may be null)
- `mergedFiles` — files auto-merged via diff3 (may be null)

### Step 5: Execute Post-Upgrade Hook

If `skill.hooks.post-upgrade` exists in the JSON output, run it:

```bash
node ~/zylos/.claude/skills/<component>/hooks/post-upgrade.js
```

This typically handles config migration. If it fails, investigate.

### Step 6: Start Service, Check Config, Review Conflicts

1. Restart the service: `pm2 restart <service-name>` (or start fresh if not registered)
2. Verify the service is healthy
3. Compare old and new SKILL.md config — if new required config items were added, collect them interactively
4. **If `mergeConflicts` exists**: Review each conflict file. Read the backup (local version) and installed (new version), then re-apply local changes using Edit tool.

## Session Mode — Self-Upgrade (zylos-core)

### Step 1: Check + Download to Temp

```bash
zylos upgrade --self --check --json
```

The CLI checks for updates **and downloads the new version to a temporary directory**. JSON output includes:
- `current`, `latest`, `hasUpdate` — version info
- `changelog` — filtered changelog text
- `localChanges` — local modifications to core skills
- `tempDir` — path to downloaded package (for template comparison)

**If already at latest version, inform user and stop.**

### Step 2: Analyze Changes, Compare Templates, and Confirm

**All information must be presented BEFORE asking for confirmation.** No surprises after execution.

1. **Analyze changes**: Read changelog from JSON + fetch commit history via `gh api`, synthesize change summary
2. **Analyze templates**: Read template files from `tempDir`, compare each with local files:
   - **New files** (not in local): list them, explain what they add
   - **Changed files** (local exists but differs from new template): show differences, let user decide (use new version / keep current)
   - **Unchanged files** (local matches new template): skip
3. **Present everything** to user: version change, change summary, template changes, user decisions needed
4. Get user confirmation (including their choices for changed files)

### Step 3: Execute Self-Upgrade

After user confirms (with full knowledge of all changes). **Reuse the temp dir from Step 1**:

```bash
zylos upgrade --self --yes --json --temp-dir <tempDir>
```

The CLI handles: backup, npm install -g from tempDir, smart merge Core Skills, sync CLAUDE.md, sync settings hooks, restart PM2 services, verify, **cleanup tempDir**.

JSON output includes:
- `mergeConflicts` — core skill files where local was backed up
- `mergedFiles` — core skill files auto-merged via diff3
- `migrationHints` — hook changes auto-applied to settings.json

### Step 4: Deploy Templates

Deploy templates according to the decisions made in Step 2:
- New files: copy from the newly installed package's template directory
- Changed files: follow user's choice (overwrite or keep)
- Unchanged files: skip

### Step 5: Review Conflicts + Restart

1. **If `mergeConflicts` exists**: Review each conflict. Read backup and installed versions, re-apply local changes.
2. If the upgrade changed hooks or skills, execute `restart-claude` to load new configuration.

## C4 Mode — Component Upgrade

**Upgrades ALWAYS use two-step confirmation. NEVER skip step 1 and go directly to step 2.**
**Even if the user says "帮我升级", "please upgrade", or any variation — always do step 1 first.**

### Step 1 — User requests upgrade

User: `upgrade telegram`

Run `zylos upgrade telegram --check --json`, parse the JSON output. **Save the `tempDir` from output** for use in confirm step. Then **actively analyze what changed**:

1. Read the `changelog` field from JSON output (if present)
2. Fetch commit history: `gh api repos/zylos-ai/zylos-<component>/compare/v<current>...v<latest> --jq '.commits[].commit.message'` (with proxy)
3. Synthesize a clear change summary from both sources — explain what changed and why, don't just copy changelog text
4. Compare files from `tempDir` with installed skill directory — note new, changed files

Reply with ALL of the following:
1. Version change: `<name>: <current> -> <latest>`
2. Change summary: your synthesized analysis of what changed (using changelog + commits)
3. File changes: new files, changed files
4. Local changes: show if any, or "none"
5. Confirm instruction

**You MUST analyze and explain what changed. Do NOT just show version numbers and ask to confirm.**

Example reply:
```
telegram: 0.1.0 -> 0.2.0

Changes:
- Fixed dotenv path resolution that caused config loading failures
- Added admin CLI for managing groups and whitelist directly

File changes:
- New: hooks/pre-upgrade.js
- Updated: hooks/post-install.js, SKILL.md

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

Smart merge will handle these automatically:
  src/bot.js: both sides changed — will attempt diff3 merge, backup if conflict
  custom-plugin.js: user-added file — will be preserved

Reply "upgrade telegram confirm" to proceed.
```

### Step 2 — User confirms

User: `upgrade telegram confirm`

1. Run pre-upgrade hook if it exists (check SKILL.md hooks)
2. Run `zylos upgrade telegram --yes --skip-eval --json --temp-dir <tempDir>` (reuse tempDir saved from Step 1)
3. Run post-upgrade hook if `skill.hooks.post-upgrade` exists in result
4. Restart service if `skill.service` exists in result
5. **If `mergeConflicts` in result**: Review and re-merge backed-up local changes
6. Reply with version change, merge summary, and any action results

If the upgrade failed, report the error and rollback status from JSON.

### Post-Upgrade Actions

After upgrade succeeds:

1. **Hooks**: If `skill.hooks.post-upgrade` exists, run it.
2. **Service**: If `skill.service` exists, restart and verify.
3. **Config**: If new config items added, inform user.
4. **Conflicts**: If `mergeConflicts` exists, review and re-merge.

Reply with version change, change summary, and any action results.

## C4 Mode — Self-Upgrade (zylos-core)

Same two-step pattern for upgrading zylos itself. **All information shown before confirmation.**

### Step 1 — User requests

User: `upgrade zylos`

Run `zylos upgrade --self --check --json`. **Save the `tempDir` from output.** Then:

1. **Analyze changes**: Read changelog + fetch commit history via `gh api repos/zylos-ai/zylos-core/compare/v<current>...v<latest> --jq '.commits[].commit.message'` (with proxy). Synthesize change summary.
2. **Analyze templates**: Read template files from `tempDir`, compare with local files. Categorize as new / changed / unchanged.
3. **Reply with ALL information**:

```
zylos-core: 0.1.0 -> 0.2.0

Changes:
- Smart merge replaces preserve strategy for upgrades
- Three-way merge with diff3, automatic conflict backup

Template changes:
- New: memory/identity.md, memory/state.md
- Updated: CLAUDE.md, .claude/settings.json

Local skill modifications:
  M activity-monitor/scripts/heartbeat.js

Smart merge will handle modifications automatically.

Reply "upgrade zylos confirm" to proceed.
```

If already up to date, reply: `zylos-core is up to date (v0.1.0)`

### Step 2 — User confirms

User: `upgrade zylos confirm`

1. Run `zylos upgrade --self --yes --json --temp-dir <tempDir>` (reuse tempDir saved from Step 1)
2. Deploy templates per user's decisions from Step 1 (new files: copy, changed: follow user choice, unchanged: skip)
3. **If `mergeConflicts` in result**: Review and re-merge backed-up local changes
4. If hooks/skills changed, execute restart-claude
5. Reply with version change and change summary
