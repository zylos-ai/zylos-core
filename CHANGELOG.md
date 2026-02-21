# Changelog

All notable changes to zylos-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-02-22

### Added
- Smart merge: three-way merge strategy replaces preserve-or-overwrite for upgrades
- `diff3.js`: three-way merge utility using GNU diff3 — clean merges for non-conflicting changes
- `smart-merge.js`: per-file merge strategy (overwrite/keep/merged/conflict/added) with backup for conflicts
- Manifest originals storage: saves installed file copies in `.zylos/originals/` for future three-way merge base
- File deletion during upgrades: files removed in new version are deleted from installed dir (user-added files preserved)
- Unit tests for diff3, smart-merge, and manifest modules (37 tests via Jest)

### Changed
- `self-upgrade.js`: `syncCoreSkills()` uses `smartSync()` instead of preserve-or-overwrite branch
- `upgrade.js`: step 3 uses `smartSync()` instead of brute-force `syncTree()`
- `component.js`: C4 reply format includes merge/conflict info for both component and self-upgrade
- `component-management` SKILL.md: upgrade workflow documentation updated for smart merge

### Fixed
- File deletion in `upgrade.js` no longer deletes user-added files — only files tracked in old manifest are removed

## [0.2.1] - 2026-02-21

### Added
- Event-driven context monitoring via Claude Code's `statusLine` hook — replaces hourly polling with zero turn cost (`context-monitor.js`)
- Session cost tracking: `context-monitor.js` logs final session cost to `cost-log.jsonl` when session changes
- `new-session` skill: pre-clear handoff checklist that preserves background tasks and hands off task IDs to new session
- `statusLine` config in `templates/.claude/settings.json` — pipes context data to `context-monitor.js` after every turn
- statusLine sync support: `sync-settings-hooks.js` and `self-upgrade.js` now add, update, and remove `statusLine` config from template

### Fixed
- `zylos upgrade --self --check --branch <name>`: version check always read from main instead of the specified branch

### Changed
- `check-context` skill simplified: reads `statusline.json` directly instead of enqueuing `/context` command
- Activity monitor bumped to v13: removed all polling-based context check code (`maybeEnqueueContextCheck`, `enqueueContextCheck`, related state files)
- Activity monitor SKILL.md: rewritten Context Monitoring section to document statusLine mechanism and two-stage design

### Removed
- `check-context/scripts/check-context.js`: no longer needed (statusline.json is always current)
- Activity monitor polling functions: `loadContextCheckState`, `writeContextCheckState`, `enqueueContextCheck`, `maybeEnqueueContextCheck`

## [0.2.0] - 2026-02-21

### Added
- Heartbeat v2: replace verify phase with stuck detection — no activity for 5 min triggers immediate probe with 2 min timeout
- Hook-based activity tracking: Claude Code hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit) replace non-functional fetch-preload
- Recovery backoff: failed recovery attempts wait progressively longer (1 min, 2 min, ... up to 5 min cap)
- DOWN state periodic retry: after exhausting recovery budget, check back every 30 min
- Daily upgrade check: queries GitHub at 6 AM for newer versions of core and all installed components, notifies via C4
- Diagnostic logging: hook timing, delivery failures, and tmux captures logged to activity-monitor directory
- Recovery notices: notify pending channels when Claude comes back online after downtime
- Auto-sync settings.json hooks on upgrade: template is now the single source of truth for all hook configurations
- `applyMigrationHints()` in self-upgrade pipeline (step 8): automatically adds missing hooks, updates modified hooks, removes obsolete core hooks
- `sync-settings-hooks.js` standalone script for postinstall path
- `hook-utils.js` shared module for hook matching utilities

### Fixed
- Stuck probe cooldown: short retry (60s) on probe failure, full cooldown on success
- Heartbeat state machine: prevent deadlock when enqueue fails during recovery
- Reset hook activity state on Claude restart to prevent false busy detection
- Deduplicate recovery notices for same chat with different message IDs
- Preserve failed notifications in pending-channels file instead of discarding
- postinstall.js: use execFileSync instead of execSync to prevent shell injection
- Tmux capture truncation: keep last 8KB (most recent content) instead of first 8KB
- Upgrade check: normalize v-prefix on both sides of version comparison
- Upgrade check: return false on C4 enqueue failure to allow DailySchedule retry
- DOWN state retry: only advance lastDownCheckAt after successful enqueue
- Settings.json hooks not updated during `zylos upgrade core`

### Changed
- `postinstall.js` uses template-based hook sync instead of `setup-hooks.js`
- `templates/.claude/settings.json` now includes all hooks (SessionStart + activity-monitor)
- Upgrade check runs as detached child process to avoid blocking monitor loop
- Safety-net heartbeat interval relaxed to 2 hours (stuck detection is primary mechanism)
- Activity monitor bumped to v12

### Removed
- `setup-hooks.js`: replaced by `sync-settings-hooks.js` which handles all hooks from the template

## [0.1.9] - 2026-02-21 _(superseded by 0.2.0 — settings.json hooks were not synced on upgrade)_

## [0.1.8] - 2026-02-18

### Added
- restart-claude: structured 5-step pre-restart session handoff checklist — stop background tasks, sync memory, write handoff summary, send to user/console, enqueue /exit (#117)
- upgrade-claude: same 5-step pre-upgrade session handoff checklist (#117)
- CLAUDE.md: context overflow protection rule — research tasks with many searches must use background subagents (#116)
- upgrade-claude: ISO timestamps on all log output for post-mortem analysis (#118)

### Fixed
- `zylos add`: try public URL first before authenticated GitHub API — fixes 403 on public repos when token lacks org access (#115)
- `fetchRawFile` and `fetchLatestTag`: same public-first fallback pattern (#115)

## [0.1.7] - 2026-02-17

### Added
- Dispatcher `REQUIRE_IDLE_MIN_SECONDS` config: sustained idle check before delivering require_idle messages (#113)

### Fixed
- Remove endpoint format restriction from C4 validation — endpoint format is now channel-specific (#113)
- restart-claude: use c4-control enqueue instead of nohup script to prevent race condition (#113)
- upgrade-claude: use c4-control enqueue instead of script-level idle detection (#113)
- upgrade-claude: cancel queued /exit on timeout abort to prevent orphaned restarts (#113)
- upgrade-claude: add ack-deadline to /exit enqueue to prevent stale running records (#113)
- check-context: use c4-control enqueue with `--with-restart-check` flag (#113)
- Dispatcher: require `idle_seconds >= 3` (sustained idle) before delivering require_idle messages (#113)

### Changed
- Increase file attachment threshold from 1KB to 2KB (#113)
- Simplify activity-monitor `enqueueContextCheck()` to delegate to check-context.js (#113)
- Delete legacy `restart.js` script (no remaining callers) (#113)
- Session-start-prompt: enqueue via c4-control instead of direct c4-receive (#113)

## [0.1.6] - 2026-02-17

### Added
- `zylos upgrade --branch <name>` flag for testing PR branches before merge (#111)
- Session startup hook (`session-start-prompt.js`) for injecting context at session start (#111)
- Upgrade migration hints: detect new, modified, and removed hooks by script path matching (#111)
- `hasStartupHook()` with fallback to C4 control enqueue when hook is not configured (#111)

### Changed
- Context check split into two-step flow with deadline spacing (600s/630s) (#111)
- Write context check state before enqueue to prevent retry flooding (#111)
- Control queue dispatch uses ORDER BY id for deterministic FIFO ordering (#111)

### Fixed
- Resolve repo fallback for `--branch` upgrade when version check fails (#111)
- Reject flag-like values (e.g. `--self`) as branch names (#111)
- Anchor `hasStartupHook()` regex to path separator to prevent false matches (#111)
- Extract last path-like token in hook commands to skip shell prefixes (#111)

## [0.1.5] - 2026-02-15

### Added
- Default to latest release tag instead of main branch when installing components (#105)

### Fixed
- Distinguish network errors from missing releases in `zylos add` (#105)
- Run daily memory commit in `~/zylos/memory/` instead of `~/zylos/` (#106)
- Remove timeout on post-install hook execution to support interactive hooks (#107)

## [0.1.4] - 2026-02-14

### Added
- Terminal color highlighting for all CLI commands — zero-dependency ANSI colors (#102)
- Web console: auto-configure Caddy route, password generation, and URL display (#101)

### Fixed
- Fix PM2 startup: use spawnSync to capture output on non-zero exit (#99)
- Adapt auth flow to new Claude Code CLI commands (#100)
- Redirect bare `/console` to `/console/` for Caddy wildcard routes (#103)

## [0.1.3] - 2026-02-13

### Added
- PM2 boot auto-start during `zylos init` — services survive reboot (#98)

## [0.1.2] - 2026-02-13

### Added
- Activity monitor: enqueue startup control after launching Claude (#94)
- Web console: read password from .env file directly (#97)

### Fixed
- Add nextSteps and SKILL.md guidance to C4 install flow (#95)
- Make nextSteps handling explicit and actionable in install workflow (#96)

## [0.1.1] - 2026-02-12

### Added
- Configurable HTTP/HTTPS protocol for Caddy (`zylos config set protocol http/https`) (#90)
- `zylos add --branch` flag for installing components from specific git branches (#92)
- Behavioral rule: isolate web operations from main loop (#89)
- Recommend nvm for Node.js installation in docs (#88)

### Fixed
- Strip `\r\n` from user input during interactive config collection (#91)
- Prevent Ctrl+C during `claude auth` from killing `zylos init` process (#93)

## [0.1.0] - 2026-02-11

Initial public release.

### Added
- Complete CLI: `zylos init`, `add`, `upgrade`, `remove`, `info`, `list`, `search`
- Component registry with GitHub-based distribution
- 8-step upgrade pipeline with backup, rollback, and manifest-based preservation
- Memory v5 (Inside Out architecture): tiered persistence with identity, state, references
- Memory Sync as forked subagent — runs in background without blocking main agent
- C4 Communication Bridge with control queue, heartbeat liveness, periodic task dispatch
- User-space Caddy: download binary, prompt for domain, generate Caddyfile, PM2-managed
- Caddy auto-configuration for components declaring `http_routes`
- Interactive component setup: `zylos add` prompts for config, writes `.env`, starts service
- SKILL.md `bin` field support: component CLIs symlinked to `~/zylos/bin/`
- Self-upgrade support for IM channels with two-step confirmation
- Claude Code auth flow in `zylos init`
- Timezone selection during init (auto-detect + confirm)
- Core Skills sync with user modification detection
- Lock-based concurrency control for upgrades
- `--json` output mode for programmatic consumption
- ESM-only codebase

### Infrastructure
- GitHub Actions CI workflow
- Modular lib/ architecture (config, components, download, github, manifest, skill, etc.)
