# Changelog

All notable changes to zylos-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
