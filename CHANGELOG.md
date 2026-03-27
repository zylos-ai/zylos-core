# Changelog

All notable changes to zylos-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.9] - 2026-03-27

### Fixed
- **Idle heartbeat auto-ack limited to primary probes**: only periodic `primary` heartbeat probes are auto-acked when the agent is healthy and stably idle; `stuck`, `recovery`, and `down-check` phases still require full end-to-end delivery to verify liveness (#431)
- **Auth probe diagnostics improved**: `checkAuth()` fallback branch now includes the CLI output (truncated to 500 chars) in the result, and Guardian logs the actual error text for easier remote debugging (#432)
- **Spurious auth-failure C4 notification removed**: Guardian no longer enqueues a control message on auth failure — the existing passive reply in `c4-receive.js` already notifies users when they send a message during auth_failed state (#432)

### Added
- **Heartbeat phase tagging**: heartbeat content now includes `[phase=primary|stuck|recovery|down-check]` markers, enabling phase-aware dispatch decisions (#431)
- **Atomic status file writes**: `atomicWriteJson()` in activity-monitor prevents torn writes to the agent status file; `readJsonFileWithRetry()` in c4-dispatcher adds retry-on-parse-failure for robustness (#431)

## [0.4.8] - 2026-03-26

### Added
- Base URL support (#418)

## [0.4.7] - 2026-03-26

### Fixed
- **Periodic probe interval corrected to 30 minutes**: activity-monitor periodic liveness checks were unintentionally reduced from 5 minutes to 3 minutes in v0.4.1. They now run every 30 minutes as intended, avoiding unnecessary idle probe traffic while preserving message-triggered and heartbeat-based recovery paths (#426)

## [0.4.6] - 2026-03-26 _(superseded by 0.4.7 — restores the intended periodic probe interval after the previous over-aggressive reduction)_ ⚠️ UPGRADE STRONGLY RECOMMENDED

> **All instances should upgrade to this version.** Heartbeat probes previously used normal priority (3), which could be delayed behind queued conversation messages. This caused false liveness timeouts and unnecessary kill-restart cycles. v0.4.6 sets heartbeat priority to 0 (highest), ensuring timely delivery regardless of queue depth.

### Fixed
- **Heartbeat probe priority elevated to highest (0)**: both `claude-probe` and `codex-probe` now enqueue heartbeat checks at priority 0 instead of 3, preventing false timeout kills when the C4 queue has pending conversation messages (#421)

## [0.4.5] - 2026-03-26 _(superseded by 0.4.6 — heartbeat priority fix prevents false timeout kills)_

### Fixed
- **Codex self-upgrade config backfill**: `0.4.3 -> 0.4.4` upgrades now also backfill `~/.codex/config.toml` through the installed `sync-settings-hooks.js` path, so Codex sessions get `[features] multi_agent = true` even when the running upgrader is still the old 11-step flow (#415)
- **Symlinked skills-root backup path**: self-upgrade now handles installations where the top-level `skills/` directory is itself a symlink, avoiding `EEXIST` failures during `backup_core_skills` (#414)

## [0.4.4] - 2026-03-26 _(superseded by 0.4.5 — self-upgrade compatibility fixes for symlinked skills roots and Codex config backfill)_

### Added
- **Codex multi-agent config bootstrap**: `init`, runtime switching, and self-upgrade now ensure `~/.codex/config.toml` contains `[features] multi_agent = true` for Codex sessions (#407)

### Fixed
- **Codex startup bootstrap flow**: startup hooks now inject session context reliably, and the startup control prompt avoids redundant recent-conversation fetching during bootstrap (#400, #404)
- **Codex heartbeat delivery behavior**: heartbeat ack handling stays silent, and periodic heartbeat controls now use normal priority instead of the previous overly aggressive queue priority (#384, #408)
- **Codex context rotation / new-session flow**: context rotation now routes through the `new-session` skill, enforces handoff behavior correctly, and uses `/exit` as the Codex session switch command (#401, #403, #406)
- **Codex Memory Sync / new-session guidance**: runtime instructions now distinguish Claude vs Codex behavior correctly, remove the invalid Codex `model: sonnet` guidance, and require Memory Sync to finish before enqueueing Codex `/exit` (#411)

## [0.4.3] - 2026-03-22 _(superseded by 0.4.4 — Codex session rotation, Memory Sync, and heartbeat flow fixes)_

### Added
- **OpenClaw ecosystem compatibility**: documentation for skill installation, capability mapping, and natural-language skill messaging (#372)

### Fixed
- **Codex heartbeat kill-restart loop**: replaced tmux stdin injection with C4 control queue delivery, matching Claude's architecture. Eliminates false timeouts from `rollout_path` null after restart and user conversation disruption (#379)
- **checkAuth over-engineered**: removed Stage 1 (`claude auth status`) and Stage 2 (HTTP `/v1/models`) — neither validates setup tokens or API keys reliably. Now uses only `claude -p ping --max-turns 1` for end-to-end auth verification (#378)
- **Hardcoded Chinese in context rotation message**: replaced with English — zylos-core is open source, the agent translates at runtime (#377)
- **Codex heartbeat ack instruction too vague**: updated `codex-addon.md` to explicitly instruct Codex to execute the ack command, matching Claude's template (#379)

## [0.4.2] - 2026-03-20

### Added
- **Beta version upgrades (`--beta` flag)**: `zylos upgrade --self --beta` and `zylos upgrade <component> --beta` now check for prerelease versions. Without `--beta`, only stable releases are shown — default behavior unchanged (#368)
- **Tag-based version detection for zylos-core**: self-upgrade now uses GitHub tags (unified with component upgrades) instead of reading `package.json` from the main branch (#368)

### Fixed
- **Downgrade suggestion when on beta**: `hasUpdate` now uses semver directional comparison instead of string inequality, preventing false "update available" when the user is on a higher beta version than the latest stable (e.g. 0.6.0-beta.1 → 0.5.0) (#368)
- **Chinese example messages in templates**: all example messages in `claude-addon.md`, `codex-addon.md`, and `ZYLOS.md` are now in English — the bot adapts to the user's language at runtime (#369)
- **Onboarding security copy**: refined security disclosure for cloud deployment scenarios (#364)

### Changed
- **Version query instructions**: added `zylos --version` and `zylos upgrade --self --check` guidance to ZYLOS.md and component-management SKILL.md (#365)

## [0.4.1] - 2026-03-19

### Added
- **`auth_failed` health state**: authentication failures now set a dedicated health state instead of silently staying `ok`. Users see "authentication issues — please check credentials" instead of a generic error. User messages trigger immediate auth retry with no 3-minute wait (#359)
- **Proactive API error scan**: detects API errors (HTTP 400/401/403/500) within ~15 seconds via tmux pane scanning, triggering fast heartbeat recovery instead of waiting for the next periodic probe (#355)
- **/proc context-switch sampling**: frozen-process detection via `/proc/<pid>/status` context-switch counters — catches stuck Claude processes that appear alive but aren't processing (#351)
- **API error fast-detection for heartbeat recovery**: `detectApiError` callback in HeartbeatEngine — on heartbeat failure, scans for API errors before triggering kill+restart, enabling targeted recovery (#352)

### Fixed
- **Auth recovery delayed by 3 minutes**: user messages during auth failure now clear the backoff timer immediately via the existing signal file mechanism (#359)
- **`notifyPendingChannels` skipped after auth recovery**: health was prematurely cleared to `ok` before heartbeat verification, causing queued users to miss the "service recovered" notification. Health now stays `auth_failed` until heartbeat confirms the agent is alive (#359)
- **Signal acceleration missing for `auth_failed`**: process signal detection (`_trackAgentRunning`) and acceleration (`processHeartbeat`) now include `auth_failed`, ensuring immediate heartbeat verification after auth-recovered restart instead of waiting up to 30 minutes (#359)
- **Init fails to accept Claude terms**: `zylos init` now creates `settings.json` with autonomous mode consent regardless of auth state, fixing "NOT READY — autonomous mode not yet accepted" after adding a token post-init (#357)
- **Stale heartbeat pending on new session**: `startAgent()` now clears leftover `heartbeat-pending.json` before launching, preventing false "recovering" transitions from a previous session's timed-out heartbeat (#354)
- **.env parsing breaks on special characters**: regex-based `.env` parser now handles values with spaces, quotes, and special characters; 3-minute startup grace period prevents false alarms during slow launches (#353)
- **Auth check failure causes infinite restart loop**: Guardian now suppresses restart attempts for 3 minutes after auth failure, with owner notification rate-limited to once per hour (#346)
- **Auto-restart service after upgrade**: post-upgrade hook now restarts PM2 services automatically (#345)
- **HTTP validation for API keys**: replaced 30-second ping-based validation with direct HTTP header check (`x-api-key`) for faster, more reliable auth verification (#341, #344)
- **Guard /usage against active prompts**: `/usage` check skips when an active prompt is in progress, preventing interference with ongoing Claude operations (#343)
- **`--temp-dir` contents validation before smart merge**: prevents corrupted temp directories from breaking the upgrade merge step (#342)
- **`checkAuth()` false-positive with no credentials**: handles non-zero exit and missing credentials in Claude v2.1.76+ (#336, #339, #340)
- **Codex API key leaked to .env**: API key now stored only in `~/.codex/auth.json` (#338)
- **`execSync` hangs in monitor/dispatcher**: added timeouts to all `execSync` calls to prevent indefinite blocking (#335)
- **Periodic probe interval too long**: reduced from 5 minutes to 3 minutes for faster liveness detection (#334)
- **PM2 systemd unit instability**: stable systemd integration with consistent `zylos start` behavior (#331)
- **Guardian tightly coupled to heartbeat engine**: decoupled Guardian restart logic from HeartbeatEngine internals via `canRestart()` API, live auth check before each restart, and periodic probe scheduling (#332)
- **Boot-time service discovery**: component PM2 services are now auto-discovered and started on boot (#317)

## [0.4.0] - 2026-03-15

### Added
- **OpenAI Codex runtime support**: run Zylos on Codex CLI instead of Claude Code. Switch anytime with `zylos runtime codex` — memory, skills, and channels are fully preserved across the switch (#311)
- **`zylos runtime <name>` command**: switch AI runtime at any time without reinstalling. Handles install, auth, and tmux session management automatically
- **`--runtime` and `--codex-api-key` install flags**: non-interactive Codex install support — `curl | bash -s -- --runtime codex --codex-api-key sk-xxx`. `ZYLOS_RUNTIME` and `OPENAI_API_KEY` env vars also supported (key is stored in `~/.codex/auth.json`, not `.env`)
- **RuntimeAdapter abstraction**: `ClaudeAdapter` and `CodexAdapter` implement a shared interface — all core systems (heartbeat, context monitoring, guardian) are now runtime-agnostic
- **Per-runtime instruction files**: `ZYLOS.md` (shared core) + `claude-addon.md` / `codex-addon.md` runtime addons, assembled into `CLAUDE.md` (Claude) or `AGENTS.md` (Codex) at setup time
- **Codex skill discovery**: `.agents/skills/` symlink created at Codex launch so Codex discovers all installed skills natively via the Agent Skills spec
- **Context rotation notifications**: when context is near full, the activity monitor sends a user notification before rotating to a new session — works across all communication channels
- **Per-runtime heartbeat probes**: `ClaudeProbe` and `CodexProbe` handle liveness detection for each runtime's specific behavior

### Changed
- **Layered instruction files**: `CLAUDE.md` is now assembled from `ZYLOS.md` + `claude-addon.md` on each install/upgrade. Existing `CLAUDE.md` is migrated to `ZYLOS.md` on first upgrade to v0.4.0

### Fixed
- **activity-monitor crash after upgrade from 0.3.x**: when upgrading from a pre-v0.4.0 version, the old upgrade code restarted PM2 services before deploying the new ecosystem config, leaving `ZYLOS_PACKAGE_ROOT` unset. activity-monitor now falls back to `npm root -g` to locate the runtime package, preventing the crash
- **self-upgrade rollback on slow services**: step 11 (verify services) used a one-shot 2-second check, causing false rollbacks when component services (Lark, Telegram, BotsHub) took longer than 2 seconds to restart. Now polls every 2 seconds for up to 30 seconds

## [0.3.7] - 2026-03-11

### Added
- **Comprehensive onboarding flow**: guided first-run experience with step-by-step setup wizard covering auth, channels, and Caddy configuration (#291)
- **Interactive security consent**: users must explicitly accept autonomous mode permissions during installation, replacing silent opt-in (#306)

### Fixed
- **API key exposed in process command line**: replaced `execSync` string interpolation with `execFileSync` + temp env file pattern — secrets no longer visible in `ps aux` or `/proc/cmdline` (#289)
- **Web console URL shows /console/ without Caddy**: `zylos init` and `zylos doctor` now show direct `ip:port` URL when Caddy is not configured, instead of the Caddy-only `/console/` path (#307)
- **Context rotation delivery deadlock**: fixed deadlock where context rotation and message delivery could block each other, causing session restart failures (#274)
- **PM2 daemon foreign cgroup warning**: detect and warn when PM2 daemon runs in a different cgroup (e.g., after system upgrade), which can cause silent service failures (#302)
- **Local address detection for Caddy**: automatically detect localhost/private IPs and configure HTTP on a high port instead of requesting HTTPS certificates (#298)
- **Recovery notification dedup failure**: fix dedup key parsing when message contains `|req:xxx` suffix, preventing duplicate recovery notifications (#270)
- **Docker entrypoint working directory**: fix Claude starting in wrong directory inside Docker container (#292)

## [0.3.6] - 2026-03-09

### Added
- **Interactive CLI mode (`zylos shell`)**: minimal-dependency REPL that communicates with Claude via C4 — the simplest way to talk to your agent (#278)
- **Docker deployment**: full Docker support with Dockerfile, docker-compose.yml, entrypoint script, and deployment guide. Supports OAuth tokens and API keys, persistent volumes, Telegram/Lark channel passthrough, and Synology NAS (#276)
- **Docker image auto-publish to GHCR**: CI workflow builds and pushes multi-platform images (amd64 + arm64) on push to main (`:main` tag) and on version tags (`:x.y.z` + `:latest`) (#283)
- **Friendly Docker startup progress**: entrypoint now shows step-by-step progress (Step 1/4 ~ 4/4) with color-coded output, version banner, and web console URL on completion (#285)
- **Pre-uninstall lifecycle hook**: components can define a `pre-uninstall` script in their registry entry, executed before removal (#284)
- **SSH install method for unsupported platforms**: documented how to install Zylos on Windows/NAS via `claude --ssh` (#275)

### Fixed
- **Docker stop hangs**: rewrote entrypoint shutdown logic — sleep loop replaces `wait` on child PID, allowing SIGTERM trap to fire reliably (#282)

### Documentation
- Web console password retrieval guide for Docker (#286)
- `zylos shell` added as primary interaction method in README (EN + CN) and Docker docs (#287)

## [0.3.5] - 2026-03-06

### Added
- **User message triggers recovery in all unavailable states**: user messages now trigger recovery attempts in `recovering` and `down` states (not just `rate_limited`). Recovery cooldown reduced from 5 minutes to 1 minute. Error messages are honest about the bot's actual state instead of always claiming "rate limited" (#254)

### Fixed
- **False positive rate limit detection**: replaced aggressive tick-level tmux text scanning with dual-signal detection — rate limit is now only detected when both heartbeat failure AND specific rate-limit text are present in the tmux pane. Prevents conversation content containing "rate limit" keywords from triggering false positives. Includes 71 tests (#257, closes #256)
- **Rate-limited recovery deadlock**: `triggerRecovery` was blocked by a `rate_limited` guard that prevented recovery even when cooldown expired. Recovery now correctly proceeds after cooldown (#253)

## [0.3.4] - 2026-03-05

### Added
- **Exponential backoff for activity monitor**: replaces fixed 30-second retry with exponential backoff (30s → 60s → 120s → 240s, max 5 min) when Claude crashes or exits unexpectedly. Backoff resets after 60 seconds of stable runtime. Process signals (SIGTERM → SIGKILL escalation) ensure clean restarts. Includes 50 tests (#241, closes #177)
- **RATE_LIMITED health state**: activity monitor now detects Anthropic rate-limit responses (429/529), enters a dedicated `RATE_LIMITED` state with parsed reset time, and automatically recovers — either when the reset time expires or when a user message arrives (whichever comes first). Channel bots show human-readable wait times. Includes 67 tests (#242, closes #233)

### Fixed
- **Install script defaults to latest release tag**: `install.sh` without `--branch` now installs the latest GitHub release tag instead of `main`, preventing accidental installation of unreleased code (#239)
- **macOS curl|bash install PTY issue**: `zylos init` failed to authenticate on macOS when run via `curl | bash` because stdin was a pipe, not a TTY. Now allocates a fresh PTY for the Claude auth step (#231)
- **Component routes inserted into wrong Caddy block**: `zylos install` placed reverse_proxy routes outside the primary server block, causing Caddy to reject the config. Now correctly inserts into the main HTTPS block (#236)
- **Built-in registry lark description**: clarified "Lark/Feishu" → "Lark (international)" to prevent confusion with the separate `feishu` component (#244)
- **Web console password env var mismatch**: `zylos init` wrote `ZYLOS_WEB_PASSWORD` but `server.js` only read `WEB_CONSOLE_PASSWORD`. Now reads `ZYLOS_WEB_PASSWORD` with fallback to legacy name for backward compatibility (#248)

## [0.3.3] - 2026-03-04

### Added
- **Plan usage monitoring**: activity monitor periodically checks `/usage` via tmux capture during idle periods, parses session/weekly usage percentages, and sends owner notifications when thresholds are exceeded (80% warning, 90% high, 95% critical). Only checks during active hours when Claude is idle with no pending work. Configurable via `zylos config` (#225, closes #206)

### Fixed
- **Startup prompt blocking**: `ensureOnboardingComplete()` now also sets `effortCalloutDismissed` in `~/.claude.json` and `skipDangerousModePermissionPrompt` in `~/.claude/settings.json` — prevents new Claude Code interactive prompts from blocking automated startup on VMs (#227, closes #226)
- **Usage monitor fires immediately on fresh install**: `lastUsageCheckAt` defaulted to 0, causing `/usage` to trigger 30 seconds after first startup instead of waiting the full check interval. Now defaults to current time when no persisted state exists (#229)

## [0.3.2] - 2026-03-04

### Fixed
- **Auth conflict with `claude login` + `.env` API key**: Guardian now detects native `claude login` auth (credentials.json on Linux, system Keychain on macOS) and skips `.env` token injection when present — prevents "Auth conflict: Both a token and an API key are set" error. Stale tokens are also stripped from existing tmux sessions (#219, closes #218)
- **Onboarding prompts block native auth startup**: onboarding and workspace trust pre-acceptance was embedded inside `approveApiKey()`, so native auth users without `.env` tokens saw interactive prompts in tmux. Extracted `ensureOnboardingComplete()` as a standalone function called for all auth methods (#219, supersedes #217)

## [0.3.1] - 2026-03-04 _(superseded by 0.3.2 — auth conflict fix was incomplete)_

### Fixed
- **Guardian token override causes 401**: `startClaude()` always injected the static `CLAUDE_CODE_OAUTH_TOKEN` from `.env` into tmux, overriding `~/.claude/.credentials.json` which supports automatic token refresh. Once the static token expired, Claude got stuck on 401 errors despite having valid auto-refreshable credentials. Guardian now checks for `credentials.json` first and skips `.env` token injection when present. All three auth methods (claude login, setup token, API key) remain fully supported (#215, closes #211)

## [0.3.0] - 2026-03-04

### Added
- **`zylos doctor` command**: two-layer diagnostic and auto-repair system — Layer 1 runs health checks (tmux, PM2, network, Claude CLI, services, versions), Layer 2 delegates fixes to Claude when available, otherwise shows manual hints. Supports `--check` flag for diagnosis-only mode (#205, closes #202)
- **`zylos uninstall --self`**: cleanly remove zylos from the system — stops all services (tmux + PM2), uninstalls the npm package, removes `~/zylos/` and shell PATH entries, with optional interactive cleanup of PM2 and Claude CLI. PM2 service detection uses runtime path matching instead of hardcoded names. `--force` flag for non-interactive mode (#213, closes #212)

### Fixed
- `zylos init` no longer asks "Start services now?" — services always start unconditionally after init, removing an unnecessary prompt (#210)
- Install script always shows the `source` reminder after install, regardless of whether the PATH was already configured (#209, closes #207, #208)
- Resolved 3 Dependabot security alerts: minimatch ReDoS and qs prototype pollution/DoS vulnerabilities (#204)

## [0.2.7] - 2026-02-28

### Added
- **Non-interactive init**: deploy Zylos without manual intervention — pass flags like `--setup-token`, `--timezone`, `--domain` directly through `curl | bash`, and the installer handles everything unattended. Designed for Docker images, CI/CD pipelines, and batch provisioning across multiple servers. See `zylos init --help` for the full flag and environment variable list (#196, closes #195)
- **Auto-detect headless mode**: non-interactive mode activates automatically when there's no TTY (Docker, CI runners), or when `CI=true` / `NONINTERACTIVE=1` is set — no need to pass `-y` explicitly in truly headless environments (#196)
- **Setup token verification**: setup tokens are validated via an actual API call before being accepted — invalid or expired tokens are caught immediately, rolled back, and reported with a clear error instead of silently failing later (#196)
- **`install.sh --no-init`**: install dependencies and the zylos CLI without running `zylos init`, for cases where initialization needs to happen separately (#196)
- **Structured exit codes**: exit code 1 for fatal errors (invalid token, bad config), exit code 2 for partial success (e.g. Caddy download failed but core setup succeeded) — useful for scripted deployments that need to distinguish between failure modes (#196)

### Fixed
- Caddy download failed on macOS due to incorrect platform name in the URL — `darwin` now correctly maps to `mac` (#188, closes #185)
- PM2 startup `sudo` failed silently on wrong password — now prompts interactively with retry, and shows a clear message explaining auto-start is optional if it still fails (#190, closes #186)
- Authentication failure was easy to miss in init output — now shows a prominent yellow warning box at the end with the exact fix command (#196)
- Validation errors now include actionable recovery commands — each error tells you exactly what to run to fix it (e.g. "Generate one with: `claude setup-token`") (#196)
- Docker's default `TZ=UTC` could silently overwrite a user-configured timezone on re-init — `zylos init` no longer reads `TZ` from the environment, only from the `--timezone` flag (#196)

### Changed
- `WEB_CONSOLE_PASSWORD` renamed to `ZYLOS_WEB_PASSWORD` for naming consistency (old name still works as fallback) (#196)
- Logo updated to official Zylos brand logo (#184)
- README: added pronunciation guide (/ˈzaɪ.lɒs/ 赛洛丝) and non-interactive install documentation (#192, #193, #197)

## [0.2.6] - 2026-02-27

### Added
- **Setup token authentication**: authenticate on headless servers without a browser — pass a Claude setup token during `zylos init` or set `CLAUDE_SETUP_TOKEN` in `.env`, and the agent handles the rest (#174)
- **Branch install**: test unreleased changes before they land on main — `curl ... | bash -s -- --branch <name>` installs directly from any Git branch (#182)
- **Zero-step first run**: fresh installs now auto-run `zylos init` immediately after setup, so new users go from `curl | bash` to a running agent with no extra commands (#176)

### Fixed
- `curl | bash` install no longer swallows interactive prompts — stdin is properly redirected from `/dev/tty` so `zylos init` questions work inside a pipe (#179)
- Web console now shows Local + Network URL (vite-style) when no domain is configured, instead of a blank info section (#181)
- Post-install reminder box wording clarified to better guide users on next steps (#180)

## [0.2.5] - 2026-02-26

### Added
- **One-click install**: single `curl | bash` command to get Zylos up and running (#150)
- **API key authentication**: use your own `ANTHROPIC_API_KEY` as an alternative to `claude login` — key is validated on entry and all startup dialogs are auto-resolved (#165)
- **`zylos attach` command**: connect to the Claude session with a friendly UX — persistent status bar hint and 3-second overlay remind new users how to detach, with context-aware error messages when no session is running (#168)
- **Smoother first-run experience**: autonomous mode terms are pre-accepted during init, and the web console password is now prominently highlighted so it won't get lost in output (#158)
- **Smarter `zylos status`**: detects and clearly reports when Claude Code is stuck on an unaccepted prompt, instead of just showing "OFFLINE" (#158)

### Fixed
- `zylos upgrade --check --branch` now correctly compares against the branch version instead of the latest release tag (#166)
- Long messages sent via communication bridge no longer get truncated (#162)
- Caddy setup no longer warns about missing `sudo` when running as root in Docker (#171)

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
