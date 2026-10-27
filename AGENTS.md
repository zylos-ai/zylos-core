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
