# Changelog

All notable changes to zylos-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.5] - 2026-02-26

### Added
- **One-click install script**: `curl -fsSL ... | bash` for quick setup (#150)
- **API key authentication**: support `ANTHROPIC_API_KEY` as alternative to Claude login (#165)
  - Auto-approve API key in `~/.claude.json` (`customApiKeyResponses.approved` with `key.slice(-20)`)
  - Pre-set `hasCompletedOnboarding`, `hasTrustDialogAccepted`, `hasCompletedProjectOnboarding` for fresh installs
  - Key validation via real API call (401=invalid, 400=valid)
- **`zylos attach` command**: attach to Claude tmux session with detach hint (#168)
  - Tmux status bar shows persistent yellow "Ctrl+B d = detach" hint
  - `tmux display-message` shows 3-second overlay on attach
  - Smart error messages: checks PM2 status to suggest `zylos init` vs `zylos start`
- Pre-accept bypass permissions terms and prominent web console password display during init (#158)
- `zylos status` diagnostics: detect un-accepted Claude Code terms state (#158)

### Fixed
- `zylos upgrade --check` now honors `--branch` flag — reads version from branch `package.json` (#166)
- Silent output when `--check --branch` version matches installed version (#166)
- C4 `c4-send.js` stdin support to prevent message truncation (#162)
- Skip `setcap` on Caddy when running as root in Docker (#171)

## [0.2.4] - 2026-02-22

### Fixed
- **Activity monitor Intl.DateTimeFormat memory leak**: `getLocalHour()` and `getLocalDate()` created new `Intl.DateTimeFormat` instances on every call (~3/sec from DailySchedule). V8/ICU allocates native memory per instance that GC never reclaims, causing unbounded RSS growth (~18 MB per 1 000 instantiations). Hoisted formatters to module-level constants. Activity monitor bumped to v15.

## [0.2.3] - 2026-02-22

### Added
- Three-way smart merge for upgrades: non-conflicting changes auto-merge via diff3, conflicts backed up with timestamps for manual review
- Manifest originals storage: saves installed file copies in `.zylos/originals/` as merge base for future upgrades
- File deletion during upgrades: files removed in new version are cleaned up (user-added files preserved)
- `--mode overwrite` flag for `zylos upgrade`: skip smart merge, force-overwrite all files
- Event-driven context monitoring via statusLine hook: replaces hourly polling with instant, zero-turn-cost detection
- `new-session` skill: graceful context handoff via `/clear` — preserves background tasks and hands off state to new session
- Session cost tracking: logs per-session cost to `cost-log.jsonl` on session change
- Unit tests for smart merge pipeline (43 tests via Jest)
- Activity monitor exit code logging: each Claude exit logged to `claude-exit.log` with timestamp and exit code
- Activity monitor critical events now output to stdout (visible in `pm2 logs`)

### Fixed
- `zylos upgrade --self --check --branch`: version check now reads from specified branch instead of always main
- File deletion no longer removes user-added files — only files tracked in the old manifest
- Path traversal guard in manifest originals (`assertWithinDir`)
- Binary file detection to prevent corruption during text merge
- Predictable temp file path replaced with `mkdtempSync`
- Busy-wait replaced with `sleep` in self-upgrade pipeline
- Deprecated `--production` flag replaced with `--omit=dev`
- Context monitor: reduce cooldown from 10min to 5min, atomic writes (write-then-rename) to prevent state file corruption
- Context monitor: fix cost carry-over bug on session change, track `used_percentage` every turn
- Self-upgrade: step 8 shells out to newly installed `sync-settings-hooks.js` to avoid bootstrap problem
- **Postinstall bootstrap fix**: settings sync now runs even during self-upgrade, ensuring new config fields (e.g. statusLine) are synced when upgrading from any old version
- **Activity monitor PATH fix**: pass PATH to tmux session via `-e` flag — tmux server may not inherit activity-monitor's PATH, causing "command not found"
- **Activity monitor CLAUDECODE env fix**: strip `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` env vars before starting Claude in tmux — fixes infinite restart loop when PM2 inherits Claude's runtime environment
- **Activity monitor startupGrace bypass**: grace period now checked in offline branch (tmux not found), preventing 5s retry loop when Claude crashes immediately
- **Activity monitor exponential backoff**: restart delay escalates 5s → 10s → 20s → 40s → 60s cap; requires 60s stable running before reset

### Changed
- Upgrade pipeline uses smart merge instead of brute-force overwrite for both components and core skills
- C4 upgrade reply includes auto-merged files and conflict details
- `check-context` skill simplified: reads `statusline.json` directly (always current)
- Activity monitor bumped to v14: env cleanup, exponential backoff, exit logging, stdout output
- statusLine config added to settings template with auto-sync on upgrade
- `postinstall.js` restructured: skill sync and settings sync separated; settings sync always runs when zylos is initialized

### Removed
- Polling-based context check (check-context script + activity monitor hourly poll)

## [0.2.2] - 2026-02-22 _(superseded by 0.2.3 — activity monitor env pollution bug caused infinite restart loop on affected instances)_

## [0.2.1] - 2026-02-22 _(superseded by 0.2.2 — postinstall did not sync settings during self-upgrade from older versions)_

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
