# Changelog

All notable changes to zylos-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
