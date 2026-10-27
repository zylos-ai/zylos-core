# AGENTS.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Standards

### Programming Language

- **Language**: Node.js (JavaScript)
- **Runtime**: Node.js 20+

### Module System

**This project is ESM-only.**

- ✅ Always use `import` / `export`
- ❌ Do NOT use CommonJS (`require`, `module.exports`)
- ❌ Do NOT mix module systems

**Examples:**

```javascript
// ✅ Correct (ESM)
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

export function myFunction() {
  // ...
}

export default myClass;
```

```javascript
// ❌ Wrong (CommonJS)
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = myFunction;
```

## Testing

Tests never touch a live instance. The Node and Jest test runners set `HOME` and
`ZYLOS_DIR` to fresh temporary directories before any test module loads; do not
bypass these runners. Tests may override these defaults with their own isolated
fixtures. On a machine running a live Zylos instance, run `npm install`, `npm ci`,
or `npm test` only in an isolated environment: a separate Unix user, or temporary
`HOME` and `ZYLOS_DIR` with `--ignore-scripts`. The package's `postinstall` syncs
skills into `ZYLOS_DIR`. With lifecycle scripts disabled, provision required test
dependencies separately in that isolated environment.

## tmux Compatibility

Minimum supported tmux is **3.2a**. Version matrix: **3.2a, 3.3a, 3.4, 3.7c, 3.8**. 3.3a is the Debian 12 package, 3.4 the Ubuntu 24.04 package.

A change that builds tmux commands, format strings or environment values, or parses anything read back from tmux (`cli/lib/runtime/` and its callers), merges only after it passes the whole matrix. One local tmux version does not stand in for the matrix. For each version:

1. **Runtime tests.** Put a binary named `tmux` of that version first on `PATH` and point `TEST_TMUX_BIN` at it, then run `node scripts/run-node-tests.js cli/lib/runtime/__tests__/*.test.js`. Every test must pass.
2. **Real-path stress.** Launch at least 300 rounds and deliver at least 150 rounds through the real adapter code, on one socket with background session create/kill churn. Required: 0 errors, 0 tmux server crashes, 0 lines delivered to the wrong pane, 0 missing lines.
3. **Positive control.** Under the same harness, a known-bad variant must fail: for example, the guard condition made constant-true, or the previous crashing code. A run that cannot fail does not count.

Release rule: matrix green and no P0/P1 in review means the change merges. Each remaining P2/P3 becomes a backlog issue, not another revision round.

Environment readback uses `show-environment -s` and the shared
`tmux-protocol.js` data parser, never shell evaluation. Plain `NAME=value`
output is ambiguous: tmux 3.4 prints an extra backslash before `$` followed by
an ASCII letter, `_`, or `{`, and prints control bytes as C/octal escapes while
leaving literal backslashes unchanged. The `-s` form doubles literal backslashes
and escapes dollars, quotes and backticks first. Decode those shell escapes and
the print escapes together: before a dollar, a run of `2k+1` (ordinary) or
`2k+2` (3.4 named dollar) backslashes represents `k` literal backslashes.
Elsewhere paired backslashes are literal; an odd remaining backslash introduces
a shell quote/backtick or C/octal print escape. Do not globally unescape output
from capture-pane or display-message: their bytes are payload, not environment
records. Keep this rule covered across all five versions, including literal
backslashes next to dollars and control characters.

Run the scripted gate as described in `docs/tmux-matrix.md` with all five
preprovisioned binaries. It writes runtime logs, stress metrics, a failing
known-bad guard control and provenance into a fresh evidence directory.

## Release Process

When releasing a new version:

1. **Update `package.json`** — bump `version` field to the new version number
2. **Update `package-lock.json`** — run `npm install` to sync the lock file with the new version
3. **Update `CHANGELOG.md`** — add a new section following [Keep a Changelog](https://keepachangelog.com/) format with Added/Fixed/Changed/Removed subsections as applicable
4. **Commit and push** — include all three files in the PR
5. **Merge PR first** — all changes must be merged to `main` before tagging
6. **Tag and release** — after merge, create a git tag (`vX.Y.Z`) on `main` and a GitHub release with release notes summarizing the changelog

Version numbers follow [Semantic Versioning](https://semver.org/).

## Project Structure

- `skills/` - Claude Code skills (modular workflows)
- `cli/` - Command-line interface tools

## Tests

Tests and their fixtures are development-only. They are excluded from
everything that reaches user machines: the npm package (`.npmignore`) and the
GitHub source archive that `zylos upgrade --self` downloads and syncs core
skills from (`.gitattributes` `export-ignore`). Users' security scanners must
not find fake tokens or mock binaries in an installed zylos.

- **Where tests go**: module tests in a `__tests__/` directory next to the code
  (e.g. `cli/lib/__tests__/`, `skills/<skill>/scripts/__tests__/`);
  cross-module and integration tests in the root `test/`. Do not invent other
  directory names. (`skills/zylos-memory/scripts/tests/` is a legacy exception
  pending rename to `__tests__/`.)
- **Name test files `*.test.js`**. Helpers and fixtures live inside the test
  directory, never beside runtime code.
- **Runtime code never reads test paths.** Nothing outside a test directory
  may import, spawn, or read a file inside one; only dev tooling
  (`scripts/run-node-tests.js`, `npm test` scripts) may reference them.
- **Adding a new test location** that the patterns above do not cover requires
  adding it to both `.npmignore` and `.gitattributes` in the same PR, and
  checking the packed file list (`npm pack --dry-run`) and `git archive HEAD`
  before and after.

## Skills

Each skill is a self-contained module in `skills/<skill-name>/`:
- `SKILL.md` - Skill documentation (YAML frontmatter + usage guide)
- `<skill-name>.js` - Main implementation (ESM)
- `package.json` - Must include `{"type":"module"}` (add dependencies if needed)
- Other supporting files as needed

### Skill Data Directory

Runtime data (logs, databases, config) goes in `~/zylos/<skill-name>/`, NOT in the skill source directory.

```
~/zylos/
├── activity-monitor/    # activity-monitor skill data
│   └── activity.log
├── comm-bridge/         # comm-bridge skill data
│   └── c4.db
├── http/                # http skill data
│   └── caddy-access.log
└── ...
```

This keeps code (in `skills/`) separate from runtime data (in `~/zylos/`).

### Core Database Schema Changes

The C4 (`comm-bridge`), scheduler and web-console SQLite schemas are versioned.
**Any change to a core table or column** — add, remove, rename, rebuild, change a
column definition, or change existing rows as part of an upgrade — MUST:

1. Bump that owner's `SUPPORTED_SCHEMA_VERSION` and update `TABLES` / `COLUMN_DEFINITIONS` to the new layout.
2. Register one new adjacent step `MIGRATIONS[N] = { to: N+1, changes, migrate }` with a complete change declaration. Never edit released steps, `init-db.sql` or the 0→1 callback to reach the new layout.
3. Add migration tests from the historical fixtures and from a v1 database with user-added tables/columns.

Rules, declaration keys and a worked example: `docs/sqlite-migrations.md`. Undeclared changes fail the migration; upgrade rehearsal catches them before services stop.

## PM2 Process Management

### Ecosystem Configuration

**All PM2 services MUST be managed through `~/zylos/pm2/ecosystem.config.cjs`.**

This file:
- Defines all PM2-managed services
- Sets proper PATH including `~/.local/bin` and `~/.claude/bin`
- Ensures `claude` command is available to all services
- Persists across reboots when used with `pm2 save`

**Template location:** `templates/pm2/ecosystem.config.cjs`

### Adding New PM2 Services

When adding a new service:

1. **Update ecosystem.config.cjs** - Add the new service to the apps array
2. **Restart all services** - `pm2 delete all && pm2 start ~/zylos/pm2/ecosystem.config.cjs`
3. **Save configuration** - `pm2 save` (critical for reboot persistence)
4. **Update template** - Sync changes back to `templates/pm2/ecosystem.config.cjs`

**Example service entry:**

```javascript
{
  name: 'my-service',
  script: path.join(SKILLS_DIR, 'my-service', 'server.js'),
  cwd: HOME,
  env: {
    PATH: ENHANCED_PATH,  // Includes ~/.local/bin and ~/.claude/bin
    NODE_ENV: 'production'
  },
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s'
}
```

### Boot Auto-Start

Ensure PM2 auto-starts on reboot:

```bash
pm2 startup  # Follow the returned sudo command
pm2 save     # Save current process list
```

On reboot, PM2 will execute `pm2 resurrect` which reads the saved dump and starts all services with their ecosystem configuration.

### Anthropic Skills Specification

Skills follow the [Agent Skills](https://agentskills.io) open standard. Reference: https://code.claude.com/docs/en/skills

#### Directory Structure

```
my-skill/
├── SKILL.md           # Main instructions (required)
├── package.json       # {"type":"module"} for ESM
├── scripts/           # Implementation scripts
│   └── <skill>.js
├── templates/         # Optional: templates for Claude to fill
├── examples/          # Optional: example outputs
└── references/        # Optional: detailed documentation
```

#### SKILL.md Frontmatter Fields

```yaml
---
name: skill-name              # Optional, defaults to directory name
description: What and when    # Recommended, helps Claude decide when to use
argument-hint: [args]         # Optional, hint for expected arguments
disable-model-invocation: true  # Prevents Claude from auto-invoking (user only)
user-invocable: false         # Hides from /menu (Claude only, background knowledge)
allowed-tools: Read, Grep     # Tools Claude can use without permission
model: sonnet                 # Model to use when skill is active
context: fork                 # Run in subagent (isolated context)
agent: Explore                # Agent type when context: fork
hooks: ...                    # Skill lifecycle hooks
---
```

#### Invocation Control

| Frontmatter                      | User can invoke | Claude can invoke |
| :------------------------------- | :-------------- | :---------------- |
| (default)                        | Yes             | Yes               |
| `disable-model-invocation: true` | Yes             | No                |
| `user-invocable: false`          | No              | Yes               |

#### Storage Locations

| Location | Path | Applies to |
| :------- | :--- | :--------- |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` | All user's projects |
| Project  | `.claude/skills/<skill-name>/SKILL.md` | This project only |

### SKILL.md Format

```markdown
---
name: skill-name
description: Use when [trigger condition].
---

# Skill Name

[Brief description]

## When to Use

- [Trigger condition 1]
- [Trigger condition 2]

## How to Use

[Usage instructions with code examples]

## How It Works

[Technical explanation]
```
