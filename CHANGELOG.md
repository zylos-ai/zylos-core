# Changelog

All notable changes to zylos-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.18] - 2026-02-09

### Changed
- **Lifecycle refactor**: CLI now handles only mechanical operations, Claude handles intelligent operations
- upgrade.js: 8→5 step pipeline, removed pre/post hooks and service start from CLI
- add.js: removed config collection, hook execution, PM2 registration; added `--json` output with skill metadata
- self-upgrade.js: 11→9 step pipeline, removed syncProjectSettings and scheduleRestart; added `templates` output
- component-management SKILL.md: full rewrite documenting Claude responsibilities for all lifecycle operations

---

## [0.1.0-beta.17] - 2026-02-08

### Added
- **Memory v5 (Inside Out architecture)**: tiered persistence with identity, state, references (always loaded) + user profiles, reference files, session logs (on demand)
- Memory Sync as forked subagent (`/zylos-memory`) — runs in background without blocking main agent
- SessionStart hooks: `session-start-inject.js` (loads identity/state/references) + `c4-session-init.js`
- Supporting scripts: session rotation, daily git commit, consolidation report, memory status
- 69 tests passing across shared utils, session rotation, and utility functions
- Self-upgrade Step 7: sync `templates/.claude/` project settings (SessionStart hooks) during upgrades
- Self-upgrade Step 11: auto-restart Claude after upgrade to load new skills/hooks
- `copyMissingTree` helper: only adds missing files, never overwrites user modifications
- Backup + rollback support for `.claude/` project settings

### Changed
- Self-upgrade pipeline expanded from 9 to 11 steps
- New API endpoint for unsummarized conversation ID range
- Removed `threshold-check.js` hook (replaced by Memory v5 session management)

---

## [0.1.0-beta.16] - 2026-02-08

### Fixed
- Preserve list trailing slash bug: `data/` in SKILL.md now correctly matches `data` during upgrades
- `syncTree` delete phase also normalizes trailing slashes before comparison

### Changed
- `registerService()` now uses `ecosystem.config.cjs` when available instead of plain `pm2 start`

---

## [0.1.0-beta.15] - 2026-02-08

### Changed
- C4 reply formatting: hybrid approach — Claude crafts replies from JSON data, `reply` field as fallback
- C4 uninstall: user chooses "confirm" (keep data) or "purge" (delete all data)
- Improved uninstall-check reply text for better user clarity

---

## [0.1.0-beta.14] - 2026-02-08

### Added
- C4 uninstall support: two-step confirmation flow (preview + confirm)
- `zylos uninstall --check --json` for previewing what will be removed
- `zylos uninstall --json` for structured uninstall output with `reply` field
- `formatC4Reply` cases: `uninstall-check` and `uninstall`

### Changed
- SKILL.md: uninstall no longer rejected in C4 mode, uses two-step confirm like upgrades
- C4 uninstall keeps data directory by default (no `--purge` via C4)

---

## [0.1.0-beta.13] - 2026-02-08

### Added
- `reply` field in all `--json` outputs: pre-formatted C4 reply that Claude can use directly
- `formatC4Reply()` function centralizes C4 reply formatting in CLI (decouples from SKILL.md)
- Changelog now included in plain text upgrade success output (backward compatibility)

### Changed
- C4 reply formatting moved from SKILL.md instructions to CLI-generated `reply` field
- SKILL.md: added "C4 Reply Formatting" section documenting `reply` field usage

---

## [0.1.0-beta.12] - 2026-02-08

### Fixed
- C4 upgrade confirm command was missing `--json` flag, causing Claude to get plain text instead of structured JSON with changelog
- Upgrade completion message in C4 mode now includes changelog (tells user what actually changed)

---

## [0.1.0-beta.11] - 2026-02-08

### Fixed
- Component upgrade JSON output now includes changelog (was only included in self-upgrade)

---

## [0.1.0-beta.10] - 2026-02-08

### Added
- Self-upgrade now syncs managed sections of CLAUDE.md (step 6 of 9)
- Managed section markers in CLAUDE.md template for targeted updates

### Fixed
- Removed `upgrade --yes` shortcut from CLAUDE.md template that caused Claude to skip two-step upgrade confirmation flow
- Step counter in upgrade progress display now matches actual step count

### Changed
- Self-upgrade pipeline expanded from 8 to 9 steps (added CLAUDE.md sync)

---

## [0.1.0-beta.9] - 2026-02-08

### Fixed
- `zylos info` now falls back to package.json when SKILL.md version is missing
- Stronger two-step confirmation warnings in component-management SKILL.md for C4 mode

---

## [0.1.0-beta.8] - 2026-02-08

### Fixed
- Added `zylos` CLI path note to component-management SKILL.md (use global command, not relative path)

---

## [0.1.0-beta.7] - 2026-02-07

### Changed
- Version bump for real-time progress testing

---

## [0.1.0-beta.6] - 2026-02-07

### Changed
- Upgrade steps now display in real time (both self-upgrade and component upgrade)

---

## [0.1.0-beta.5] - 2026-02-07

### Changed
- Version bump for self-upgrade flow testing

---

## [0.1.0-beta.4] - 2026-02-07

### Fixed
- Self-upgrade: service detection now uses PM2 exec path matching instead of SKILL.md declarations
- Self-upgrade: show changelog and local skill modifications before confirming

### Added
- CHANGELOG.md for zylos-core version tracking
- `--check` mode now detects local core skill modifications

---

## [0.1.0-beta.3] - 2026-02-07

### Fixed
- Template CLAUDE.md: quote channel and endpoint in reply-via example
- Self-upgrade: use npm pack to avoid broken symlinks after temp dir cleanup
- Self-upgrade: dynamic service detection from installed SKILL.md frontmatter

---

## [0.1.0-beta.2] - 2026-02-07

### Fixed
- Self-upgrade: add main branch fallback when git tag not found (for pre-release versions)

### Added
- `--version` flag for zylos CLI

---

## [0.1.0-beta.1] - 2026-02-07

### Added
- Self-upgrade support for IM channels (`upgrade zylos` / `upgrade zylos confirm`)
- `--self --check --json` mode for C4 channel integration
- Claude eval in `--check` mode (changelog + local changes in JSON output)

### Changed
- C4 comm-bridge optimization: `--source` renamed to `--channel`
- Component management SKILL.md: added C4 self-upgrade flow documentation

---

## [0.1.0] - 2026-02-06

### Added
- Complete CLI rewrite: `zylos init`, `add`, `upgrade`, `remove`, `info`, `list`, `search`
- 8-step upgrade pipeline with backup, rollback, and manifest-based preservation
- Claude eval integration for upgrade safety analysis
- Component registry with GitHub-based distribution
- Lock-based concurrency control for upgrades
- `--json` output mode for programmatic consumption
- `--all` flag for batch component upgrades
- Core Skills sync with user modification detection
- Template system (`templates/CLAUDE.md`) for `zylos init`

### Infrastructure
- ESM-only codebase (type: module)
- GitHub Actions CI workflow
- Modular lib/ architecture (config, components, download, github, manifest, skill, etc.)
