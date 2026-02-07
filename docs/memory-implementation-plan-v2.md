# Memory System - Integration & Implementation Plan v2

**Date:** 2026-02-07
**Author:** Claude Opus 4.6
**Supersedes:** [Phase 1 Memory Implementation Plan v1](memory-implementation-plan-v1.md)
**Prerequisites:** [C4 Capabilities Report](c4-capabilities-for-memory.md), [Inside Out Proposal](memory-inside-out-proposal.md), [v1 Review](memory-implementation-review.md)

---

## Critical Corrections Applied (Howard's 8 Directives)

| # | Directive | v1 Violation | v2 Resolution |
|---|-----------|-------------|---------------|
| 1 | Memory task priority > user messages | Memory sync at priority 3 (normal) | Memory sync at **priority 1** (urgent), user messages at priority 3 |
| 2 | Base on zylos-core | Mixed zylos-personal references | All paths reference zylos-core project structure exclusively |
| 3 | Memory skill is blank slate | Built on existing placeholder | Designed from scratch; existing `skills/memory/SKILL.md` fully replaced |
| 4 | `templates/CLAUDE.md` is modifiable | Not modified | Updated with memory system instructions |
| 5 | NO git commit for memory | `memory-commit.sh` used git | Removed entirely; memory files persist as plain files on disk |
| 6 | No `post-compact-inject.sh` | Referenced zylos-personal shell hook | Uses Claude Code's native hook system with Node.js scripts |
| 7 | Node.js only | `memory-commit.sh` was bash | ALL scripts are Node.js ESM. Zero shell scripts. |
| 8 | Timers through scheduler skill | No scheduler integration | All periodic operations registered via scheduler CLI |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Node.js Scripts Design](#2-nodejs-scripts-design)
3. [Hook Configuration](#3-hook-configuration)
4. [Scheduler Tasks](#4-scheduler-tasks)
5. [C4 Integration Points](#5-c4-integration-points)
6. [SKILL.md Design](#6-skillmd-design)
7. [Implementation Task List](#7-implementation-task-list)
8. [Migration Strategy](#8-migration-strategy)
9. [Testing Strategy](#9-testing-strategy)

---

## 1. Architecture Overview

### System Flow

```
                     EXISTING (C4 + Scheduler)                    NEW (Memory Skill)
                     ========================                    ==================

External Messages --> c4-receive.js --> conversations table
                                            |
                    c4-session-init.js <-----+                  session-inject.js
                    (checkpoint + convos)    |                   (core.md --> additionalContext)
                                            |
                          count > 30? ------+---> c4-threshold-check.js
                                            |        |
                                            |        v
                                            |   "[Action Required] invoke /memory-sync"
                                            |        |
                              Scheduler ----+--------+--> Memory Sync task (priority 1)
                              (periodic)    |             |
                                            v             v
                                     +-----------------------------+
                                     |     MEMORY SYNC SKILL       |
                                     |  (Claude reads SKILL.md     |
                                     |   and performs extraction)   |
                                     |                             |
                                     | 1. c4-fetch.js (read)       |
                                     | 2. Read current memory      |
                                     | 3. Extract + classify       |
                                     | 4. Write updated files      |
                                     | 5. c4-checkpoint.js (mark)  |
                                     +-----------------------------+
                                            |
                                     session-rotate.js
                                     (daily via scheduler)
```

### Key Architectural Decisions

1. **C4 DB is the conversation source of truth.** Memory Sync reads from it via `c4-fetch.js` and marks progress via `c4-checkpoint.js`. It never writes to the conversations table.

2. **Memory files are plain files on disk. No git.** Files at `~/zylos/memory/` persist across sessions, crashes, and compactions. No git add, no git commit, no version control for memory. Files are the persistence mechanism.

3. **Claude does the extraction.** Memory Sync is a Claude Code skill (SKILL.md), not an automated background script. Claude reads raw conversations and uses its reasoning to decide what to extract. This is deliberate -- extraction quality matters more than automation speed.

4. **Memory sync has higher priority than user messages.** Memory sync tasks are dispatched at scheduler priority 1 (urgent). User messages from Telegram/Lark enter C4 at priority 3 (normal). This ensures memory consolidation is never starved by incoming messages.

5. **All periodic operations go through the scheduler.** No standalone timers, no cron jobs, no PM2-based scheduling for memory. The scheduler skill (C5) owns all timing.

6. **All scripts are Node.js ESM.** No shell scripts anywhere in the memory skill. Every executable is `#!/usr/bin/env node` with `import`/`export`.

7. **Checkpoint = sync boundary.** After Memory Sync processes a batch, it creates a checkpoint. The next session-init shows this checkpoint summary for cross-session continuity.

---

## 2. Node.js Scripts Design

All scripts live in `skills/memory/scripts/`. Each is a standalone Node.js ESM executable.

### 2.1 memory-sync.js

**Purpose:** Core orchestration script for memory sync. Called by Claude as part of the memory skill workflow. Fetches conversations from C4, outputs them formatted for Claude to process.

**How it gets invoked:**
- Claude invokes it as part of the `/memory` skill workflow
- Triggered by three paths: (a) C4 session-init hook detects >30 unsummarized conversations at session start, (b) C4 threshold-check hook detects >30 mid-session, (c) scheduler dispatches periodic memory sync task

**Input:**
- `--begin <id>` -- first conversation ID to process
- `--end <id>` -- last conversation ID to process
- `--status` -- (no args) output current sync status (unsummarized count, last checkpoint)

**Output (stdout):**
- With `--begin`/`--end`: Formatted conversation data (from c4-fetch.js) plus current memory file summaries, ready for Claude to process
- With `--status`: JSON with `{ unsummarized_count, last_checkpoint_summary, last_checkpoint_id, begin_id, end_id }`

**Key logic (pseudocode):**

```
#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
const C4_SCRIPTS = path.join(SKILLS_DIR, 'comm-bridge', 'scripts');

// Parse args: --begin, --end, --status
const args = parseArgs(process.argv.slice(2));

if (args.status) {
    // Output sync status as JSON
    const statusOutput = execFileSync('node', [
        path.join(C4_SCRIPTS, 'c4-db.js'), 'unsummarized'
    ], { encoding: 'utf8' });
    // Also read last checkpoint
    const checkpointsOutput = execFileSync('node', [
        path.join(C4_SCRIPTS, 'c4-db.js'), 'checkpoints'
    ], { encoding: 'utf8' });
    // Format and output combined status
    console.log(JSON.stringify({ ...JSON.parse(statusOutput), checkpoints: ... }));
    process.exit(0);
}

if (!args.begin || !args.end) {
    console.error('Usage: memory-sync.js --begin <id> --end <id> | --status');
    process.exit(1);
}

// Step 1: Fetch conversations via c4-fetch.js
const conversations = execFileSync('node', [
    path.join(C4_SCRIPTS, 'c4-fetch.js'),
    '--begin', String(args.begin),
    '--end', String(args.end)
], { encoding: 'utf8' });

// Step 2: Read current memory state summaries
const memoryFiles = ['core.md', 'reference/decisions.md', 'reference/projects.md',
                     'reference/preferences.md', 'sessions/today.md'];
const memoryState = {};
for (const file of memoryFiles) {
    const fullPath = path.join(MEMORY_DIR, file);
    if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        // Show first 500 chars as summary to conserve context
        memoryState[file] = content.length > 500
            ? content.substring(0, 500) + '\n... (truncated)'
            : content;
    }
}

// Step 3: Output structured data for Claude to process
console.log('=== CONVERSATIONS TO PROCESS ===');
console.log(conversations);
console.log('');
console.log('=== CURRENT MEMORY STATE ===');
for (const [file, content] of Object.entries(memoryState)) {
    console.log(`--- ${file} ---`);
    console.log(content);
    console.log('');
}
console.log('=== END ===');
console.log(`Range: ${args.begin} to ${args.end}`);
```

**Dependencies:**
- Calls `c4-fetch.js` (comm-bridge) for conversation data
- Reads memory files from `~/zylos/memory/`
- Node.js built-in modules only (fs, path, os, child_process)

**Note:** This script does NOT write memory files. It prepares the data; Claude (guided by SKILL.md) reads and writes the files using its native Read/Edit/Write tools. The script also does NOT create the checkpoint -- Claude calls `c4-checkpoint.js` directly as the final step.

---

### 2.2 session-rotate.js

**Purpose:** Rotate today's session log at day boundary. Moves `sessions/today.md` to `sessions/YYYY-MM-DD.md` and creates a fresh `today.md`.

**When called:**
- Daily via scheduler task (e.g., cron `5 0 * * *` -- 00:05 every day)
- Optionally called by memory-sync.js at the start of a sync if the date has changed

**Input:** No arguments required.

**Output (stdout):** Status message indicating what was done.

**Key logic (pseudocode):**

```
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const TODAY_FILE = path.join(SESSIONS_DIR, 'today.md');

function main() {
    // Ensure sessions directory exists
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    // Use LOCAL date, not UTC (important for timezone correctness)
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    if (fs.existsSync(TODAY_FILE)) {
        const content = fs.readFileSync(TODAY_FILE, 'utf8');
        const dateMatch = content.match(/^# Session Log: (\d{4}-\d{2}-\d{2})/m);

        if (dateMatch && dateMatch[1] !== todayStr) {
            // Rotate: move to dated file
            const archivePath = path.join(SESSIONS_DIR, `${dateMatch[1]}.md`);
            fs.renameSync(TODAY_FILE, archivePath);
            console.log(`Rotated: today.md -> ${dateMatch[1]}.md`);
        } else if (dateMatch && dateMatch[1] === todayStr) {
            console.log('No rotation needed (same day).');
            return;
        }
        // If no date header found, treat as stale and overwrite
    }

    // Create fresh today.md
    const header = `# Session Log: ${todayStr}\n\n`;
    fs.writeFileSync(TODAY_FILE, header);
    console.log(`Created fresh today.md for ${todayStr}`);
}

main();
```

**Dependencies:** Node.js built-in modules only (fs, path, os). No external packages.

---

### 2.3 session-inject.js

**Purpose:** SessionStart hook script. Reads `core.md` and outputs it as `additionalContext` via Claude Code's hook JSON protocol. This ensures core memory is loaded into every new session.

**How called:** By Claude Code's native hook system as a `SessionStart` hook. The hook runner executes this script and reads its stdout as JSON.

**Input:** None (reads files from known paths).

**Output (stdout):** JSON object conforming to Claude Code hook protocol:

```json
{
  "additionalContext": "=== CORE MEMORY ===\n\n<contents of core.md>\n\n=== END CORE MEMORY ==="
}
```

**Key logic (pseudocode):**

```
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const CORE_MD = path.join(MEMORY_DIR, 'core.md');

function main() {
    const parts = [];

    if (fs.existsSync(CORE_MD)) {
        const coreContent = fs.readFileSync(CORE_MD, 'utf8');
        parts.push('=== CORE MEMORY (always loaded) ===');
        parts.push('');
        parts.push(coreContent);
        parts.push('');
        parts.push('=== END CORE MEMORY ===');
    }

    if (parts.length === 0) {
        // No core.md found -- output empty context, don't fail
        console.log(JSON.stringify({ additionalContext: '' }));
        return;
    }

    const output = { additionalContext: parts.join('\n') };
    console.log(JSON.stringify(output));
}

try {
    main();
} catch (err) {
    // Hook scripts must not crash -- output empty context on error
    console.error(`session-inject error: ${err.message}`);
    console.log(JSON.stringify({ additionalContext: '' }));
}
```

**Critical requirements:**
- Must output valid JSON to stdout (hook protocol)
- Must never throw an unhandled exception (would break session start)
- Must complete within the hook timeout (10 seconds)
- Must NOT reference `post-compact-inject.sh` or any shell script

**Dependencies:** Node.js built-in modules only (fs, path, os).

---

### 2.4 memory-status.js

**Purpose:** Utility script that outputs the current state of the memory system. Used for diagnostics and by the SKILL.md workflow.

**Input:**
- No arguments: full status report
- `--json`: output as JSON (for programmatic use)

**Output (stdout):**

```
Memory System Status
====================
Core memory:      ~/zylos/memory/core.md (2.4 KB)
Decisions:        ~/zylos/memory/reference/decisions.md (3.1 KB, 12 entries)
Projects:         ~/zylos/memory/reference/projects.md (1.8 KB, 5 entries)
Preferences:      ~/zylos/memory/reference/preferences.md (0.9 KB, 8 entries)
Session log:      ~/zylos/memory/sessions/today.md (1.2 KB, 2026-02-07)
Session archive:  3 files in ~/zylos/memory/sessions/
Archive:          0 files in ~/zylos/memory/archive/

C4 Sync Status:
  Last checkpoint:    #5 (conv 108-143, "Decisions: Agent Teams...")
  Unsummarized:       12 conversations (id 144-155)
  Threshold:          30 (not triggered)
```

**Key logic (pseudocode):**

```
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
const C4_SCRIPTS = path.join(SKILLS_DIR, 'comm-bridge', 'scripts');

// Gather file sizes
function fileInfo(relativePath) {
    const fullPath = path.join(MEMORY_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return { exists: false };
    const stat = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const entryCount = (content.match(/^### /gm) || []).length;
    return { exists: true, size: stat.size, entries: entryCount };
}

// Count files in directory
function dirCount(relativePath) {
    const fullPath = path.join(MEMORY_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return 0;
    return fs.readdirSync(fullPath).filter(f => f.endsWith('.md') && f !== 'today.md').length;
}

// Get C4 sync status
function getC4Status() {
    try {
        const unsummarized = execFileSync('node', [
            path.join(C4_SCRIPTS, 'c4-db.js'), 'unsummarized'
        ], { encoding: 'utf8' });
        return JSON.parse(unsummarized);
    } catch {
        return { count: 0, begin_id: null, end_id: null };
    }
}

// Format and output
// ...
```

**Dependencies:** Node.js built-in modules + calls `c4-db.js` for sync status.

---

### 2.5 memory-init.js

**Purpose:** Initialize the memory directory structure and template files for a fresh Zylos installation. Idempotent -- safe to run multiple times.

**When called:**
- During `zylos add memory` (component installation)
- During initial Zylos setup
- Manually for recovery

**Input:** No arguments.

**Output:** Creates the directory structure and template files.

**Key logic (pseudocode):**

```
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const DIRS = [
    'reference',
    'sessions',
    'archive'
];

const TEMPLATE_MAP = {
    'core.md': 'core.md',
    'reference/decisions.md': 'decisions.md',
    'reference/projects.md': 'projects.md',
    'reference/preferences.md': 'preferences.md',
    'sessions/today.md': 'session-day.md'
};

function main() {
    // Create directories
    for (const dir of DIRS) {
        const fullPath = path.join(MEMORY_DIR, dir);
        fs.mkdirSync(fullPath, { recursive: true });
        console.log(`Directory: ${fullPath}`);
    }

    // Copy templates (skip if target already exists and has content)
    for (const [target, template] of Object.entries(TEMPLATE_MAP)) {
        const targetPath = path.join(MEMORY_DIR, target);
        const templatePath = path.join(TEMPLATES_DIR, template);

        if (fs.existsSync(targetPath)) {
            const content = fs.readFileSync(targetPath, 'utf8').trim();
            if (content.length > 0) {
                console.log(`Skipped (exists): ${target}`);
                continue;
            }
        }

        if (fs.existsSync(templatePath)) {
            let content = fs.readFileSync(templatePath, 'utf8');
            // Replace date placeholder
            const today = new Date().toLocaleDateString('sv-SE');
            content = content.replace(/\{\{DATE\}\}/g, today);
            fs.writeFileSync(targetPath, content);
            console.log(`Created: ${target}`);
        }
    }

    console.log('\nMemory system initialized.');
}

main();
```

**Dependencies:** Node.js built-in modules only. Reads templates from `skills/memory/templates/`.

---

### Scripts Summary

| Script | Purpose | Invoked By | Writes Files? |
|--------|---------|-----------|--------------|
| `memory-sync.js` | Fetch conversations + format for Claude | Claude (skill workflow) | No (stdout only) |
| `session-rotate.js` | Rotate today.md at day boundary | Scheduler (daily) | Yes (moves/creates session files) |
| `session-inject.js` | Inject core.md at session start | Hook system (SessionStart) | No (stdout JSON) |
| `memory-status.js` | Diagnostic status output | Claude (skill) / manual | No (stdout only) |
| `memory-init.js` | Initialize memory directory structure | Installation / recovery | Yes (creates dirs + template files) |

---

## 3. Hook Configuration

### 3.1 Deployed Hook Configuration

The following hooks are configured in `~/.claude/settings.local.json` at the deployed Zylos instance. The `templates/CLAUDE.md` documents how these hooks work, but the actual `settings.local.json` is generated during installation.

**Target configuration:**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/memory/scripts/session-inject.js",
            "timeout": 10000
          },
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js",
            "timeout": 10000
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-threshold-check.js",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

### 3.2 Hook Chain Execution Order

```
EVENT: SessionStart
├── [1] session-inject.js  (memory skill)
│   └── Outputs: { additionalContext: "<core.md contents>" }
│   └── Effect: Claude starts with core identity/state in context
│
└── [2] c4-session-init.js  (comm-bridge skill, EXISTING)
    ├── Shows last checkpoint summary
    ├── Shows recent conversations (all if <30, last 6 if >30)
    └── Triggers Memory Sync if >30 unsummarized conversations

EVENT: UserPromptSubmit (every user message)
└── [1] c4-threshold-check.js  (comm-bridge skill, EXISTING)
    └── If >30 unsummarized: outputs "[Action Required] invoke /memory-sync ..."
    └── If <=30: silent (no output)
```

### 3.3 Hook Ordering Rationale

**`session-inject.js` MUST run before `c4-session-init.js`:**
- Claude needs its identity (core.md) before it can meaningfully interpret conversation history
- If reversed, Claude would see conversation data before knowing who it is or what it was working on
- Both are in the same `hooks` array, so they execute in declaration order

### 3.4 Interaction with C4's Existing Hooks

C4 already defines `c4-session-init.js` for SessionStart and `c4-threshold-check.js` for UserPromptSubmit. The memory system adds `session-inject.js` **before** the C4 session-init hook. No existing C4 hooks are removed or modified -- we prepend the memory hook.

**Important:** The `settings.local.json` file at the deployed instance is the single source of truth for hook configuration. During installation, the installer must merge memory hooks with any existing hooks rather than overwriting the file.

### 3.5 Template for zylos-core

In the zylos-core repo, we provide a hook configuration template at `skills/memory/templates/hooks.json`:

```json
{
  "_comment": "Memory system hooks - merged into ~/.claude/settings.local.json during install",
  "SessionStart": {
    "prepend": [
      {
        "type": "command",
        "command": "node {{SKILLS_DIR}}/memory/scripts/session-inject.js",
        "timeout": 10000
      }
    ]
  }
}
```

The installer resolves `{{SKILLS_DIR}}` to the actual deployed path (e.g., `~/zylos/.claude/skills`).

---

## 4. Scheduler Tasks

All periodic memory operations are registered through the scheduler skill (C5). The scheduler dispatches tasks via C4 comm-bridge, which delivers them to Claude through tmux.

### 4.1 Periodic Memory Sync

**Purpose:** Ensure memory consolidation happens regularly, even if the C4 threshold (30 conversations) is not hit.

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Memory sync: Check for unsummarized conversations and process them. Run: node ~/zylos/.claude/skills/memory/scripts/memory-sync.js --status to check. If unsummarized count > 0, invoke /memory-sync to process them." \
  --every "4 hours" \
  --priority 1 \
  --name "memory-sync"
```

**Key parameters:**
- `--every "4 hours"` -- runs every 4 hours
- `--priority 1` -- **URGENT** (higher than user messages at priority 3)
- No `--require-idle` -- memory sync is important enough to interrupt idle state promptly. The priority 1 ensures it's dispatched before queued user messages.
- No `--reply-channel` -- this is an internal operation, no external notification needed

**Why priority 1:** Howard's directive #1 states memory sync/consolidation should have HIGHER priority than user messages. In the C4 priority model: priority 1 = urgent (system/memory), priority 2 = high, priority 3 = normal (user messages). The scheduler daemon dispatches tasks ordered by `priority ASC`, so priority 1 tasks are dispatched before priority 3 user messages in the C4 queue.

### 4.2 Daily Session Rotation

**Purpose:** Rotate `sessions/today.md` to a dated archive file at the start of each day.

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Session rotation: Run node ~/zylos/.claude/skills/memory/scripts/session-rotate.js to rotate yesterday's session log." \
  --cron "5 0 * * *" \
  --priority 1 \
  --require-idle \
  --name "session-rotate"
```

**Key parameters:**
- `--cron "5 0 * * *"` -- runs at 00:05 daily (local timezone, per scheduler's DEFAULT_TIMEZONE)
- `--priority 1` -- urgent (memory operation)
- `--require-idle` -- session rotation is a quick file operation; safe to wait for idle since it's not time-critical within a few minutes
- `--miss-threshold` defaults to 300s (5 min) -- acceptable; if Claude is offline at midnight, rotation happens at next opportunity

**Note:** The `session-rotate.js` script is idempotent. If Claude was offline at midnight and the scheduler dispatches the task late, it still works correctly -- it checks the date header in today.md.

### 4.3 Memory Integrity Check (Optional)

**Purpose:** Weekly check that memory files exist and are within expected size bounds.

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Memory integrity check: Run node ~/zylos/.claude/skills/memory/scripts/memory-status.js and review. If core.md exceeds 4KB, trim the Active Working State section. If any reference file exceeds 20KB, archive old entries." \
  --cron "0 3 * * 0" \
  --priority 2 \
  --require-idle \
  --name "memory-integrity"
```

**Key parameters:**
- `--cron "0 3 * * 0"` -- runs at 03:00 every Sunday
- `--priority 2` -- high but not urgent
- `--require-idle` -- non-time-critical maintenance

### 4.4 Registration During Installation

All scheduler tasks are registered by `memory-init.js` (or a separate `register-tasks.js` script) during component installation. The script calls the scheduler CLI programmatically:

```javascript
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const CLI = path.join(os.homedir(), 'zylos', '.claude', 'skills', 'scheduler', 'scripts', 'cli.js');

const tasks = [
    {
        prompt: 'Memory sync: Check for unsummarized conversations...',
        options: ['--every', '4 hours', '--priority', '1', '--name', 'memory-sync']
    },
    {
        prompt: 'Session rotation: Run node .../session-rotate.js...',
        options: ['--cron', '5 0 * * *', '--priority', '1', '--require-idle', '--name', 'session-rotate']
    },
    {
        prompt: 'Memory integrity check: Run node .../memory-status.js...',
        options: ['--cron', '0 3 * * 0', '--priority', '2', '--require-idle', '--name', 'memory-integrity']
    }
];

for (const task of tasks) {
    try {
        execFileSync('node', [CLI, 'add', task.prompt, ...task.options], {
            encoding: 'utf8',
            stdio: 'pipe'
        });
        console.log(`Registered: ${task.options[task.options.indexOf('--name') + 1]}`);
    } catch (err) {
        console.error(`Failed to register task: ${err.message}`);
    }
}
```

### 4.5 Priority Model Summary

| Task | Priority | Idle Required? | Schedule |
|------|----------|---------------|----------|
| Memory sync | 1 (urgent) | No | Every 4 hours |
| Session rotation | 1 (urgent) | Yes | Daily 00:05 |
| Memory integrity | 2 (high) | Yes | Weekly Sun 03:00 |
| **User messages (Telegram/Lark)** | **3 (normal)** | **No** | **On-demand** |

This ensures memory operations are always prioritized above user messages in the dispatch queue.

---

## 5. C4 Integration Points

### 5.1 Where Memory Sync Fits in the C4 Pipeline

Memory Sync plugs into C4 at two points:

**Read point:** `c4-fetch.js --begin X --end Y`
- Memory sync calls this to retrieve raw conversations
- No changes to c4-fetch.js needed

**Write point:** `c4-checkpoint.js <end_id> --summary "..."`
- Memory sync calls this after processing to mark the sync boundary
- No changes to c4-checkpoint.js needed

The C4 pipeline is untouched. Memory Sync is a **consumer** of C4 data, not a modifier.

### 5.2 Priority Model in C4

The C4 conversations table has a `priority` column (1-3). The dispatcher (`c4-dispatcher.js`) processes messages in `priority ASC, timestamp ASC` order.

**Current priority usage:**
- Priority 1: System messages (via `c4-receive.js --priority 1`)
- Priority 3: User messages (default)

**With memory sync:**
- Priority 1: Memory sync tasks (via scheduler -> c4-receive.js --priority 1)
- Priority 1: System messages
- Priority 3: User messages

When the scheduler dispatches a memory sync task, it calls `c4-receive.js` with `--priority 1` (via `runtime.js:sendViaC4()`). This means if a memory sync task and a user message are both pending in the C4 queue, the memory sync task is delivered first.

### 5.3 Changes to Existing C4 Scripts

**c4-session-init.js:** No changes needed. It already:
- Shows the last checkpoint summary
- Shows recent conversations
- Triggers Memory Sync when >30 unsummarized conversations
- The trigger message says `/memory-sync --begin X --end Y` -- this matches our skill invocation

**c4-threshold-check.js:** No changes needed. It already:
- Checks unsummarized count on each user message
- Outputs Memory Sync trigger when threshold exceeded
- Silent when under threshold

**c4-config.js:** No changes needed. Current settings are appropriate:
- `CHECKPOINT_THRESHOLD = 30` (triggers sync after 30 unsummarized conversations)
- `SESSION_INIT_RECENT_COUNT = 6` (shows last 6 conversations at session start when over threshold)

### 5.4 Checkpoint Flow

```
1. C4 hooks detect >30 unsummarized conversations
   OR scheduler dispatches periodic memory sync task

2. Claude receives: "[Action Required] invoke /memory-sync --begin 108 --end 143"
   OR "Memory sync: Check for unsummarized conversations..."

3. Claude follows SKILL.md instructions:
   a. Runs: node memory-sync.js --status
      -> Sees: { count: 35, begin_id: 108, end_id: 143 }
   b. Runs: node memory-sync.js --begin 108 --end 143
      -> Gets formatted conversations + current memory state
   c. Reads full memory files (core.md, reference/*.md, sessions/today.md)
   d. Analyzes conversations, extracts decisions/preferences/projects/events
   e. Updates memory files using Edit/Write tools
   f. Runs: node c4-checkpoint.js 143 --summary "Decisions: Agent Teams. Projects: C4 merged."
      -> Creates checkpoint marking conversations 108-143 as summarized

4. Next session start:
   - session-inject.js outputs updated core.md
   - c4-session-init.js shows new checkpoint summary
   - Unsummarized count reset to conversations after id 143
```

### 5.5 What Happens During Context Compaction

Context compaction triggers a SessionStart event. The hook chain:
1. `session-inject.js` re-injects core.md (preserving identity across compaction)
2. `c4-session-init.js` shows checkpoint + recent conversations

This provides Claude with everything needed to resume after compaction without reading the full conversation history.

---

## 6. SKILL.md Design

The complete SKILL.md for `skills/memory/`:

```markdown
---
name: memory
description: >-
  Persistent memory system for cross-session context (C3 component).
  Invoke when C4 hooks report unsummarized conversations exceeding threshold,
  when the scheduler dispatches a memory sync task, or when you need to
  read/update memory files. Reads conversations via c4-fetch.js,
  extracts decisions/preferences/tasks/context updates, writes to
  memory files, and creates a C4 checkpoint.
argument-hint: [--begin <id> --end <id>]
allowed-tools: Read, Edit, Write, Bash, Grep
---

# Memory System (C3)

Maintains persistent memory across sessions via structured markdown files.
Memory files persist as plain files on disk -- no git commits required.

## Memory File Layout

Located at `~/zylos/memory/`:

| File | Purpose | Size Target |
|------|---------|-------------|
| `core.md` | Identity, user profile, active working state, key references | ~3KB max |
| `reference/decisions.md` | Active decisions constraining behavior | Variable |
| `reference/projects.md` | Active and planned projects | Variable |
| `reference/preferences.md` | User preferences and working style | Variable |
| `sessions/today.md` | Current day's session log | Variable |
| `sessions/YYYY-MM-DD.md` | Previous session logs (auto-rotated) | Read-only |
| `archive/` | Cold storage for old/superseded items | Append-only |

### File Hierarchy (What Gets Loaded When)

- **Always loaded:** `core.md` (via SessionStart hook, injected automatically)
- **Loaded on demand:** `reference/*.md` (read when you need specific decisions/preferences/projects)
- **Append during session:** `sessions/today.md` (log significant events)
- **Never loaded automatically:** `archive/`, old session logs

## When to Read Memory

**At session start (automatic):** core.md is injected via hook. You receive it in your context as "=== CORE MEMORY ===".

**When you need specific info:**
- Looking for a past decision? Read `~/zylos/memory/reference/decisions.md`
- Need to know project status? Read `~/zylos/memory/reference/projects.md`
- User preference unclear? Read `~/zylos/memory/reference/preferences.md`

## When to Update Memory

Update memory **proactively** -- don't wait for prompts:
- After completing a significant task
- When the user makes a decision or states a preference
- When switching work topics (update core.md Active Working State)
- During natural pauses in conversation
- When the scheduler dispatches a memory sync task

## Memory Sync Flow

When triggered (by C4 hooks reporting >30 unsummarized conversations, or by scheduler):

### Step 1: Check status

```bash
node ~/zylos/.claude/skills/memory/scripts/memory-sync.js --status
```

If unsummarized count is 0, report "No conversations to process" and stop.

### Step 2: Fetch and review conversations

```bash
node ~/zylos/.claude/skills/memory/scripts/memory-sync.js --begin <begin_id> --end <end_id>
```

This outputs formatted conversations and current memory state summaries.

### Step 3: Read current memory files

Read these files to understand what's already stored:
- `~/zylos/memory/core.md`
- `~/zylos/memory/reference/decisions.md`
- `~/zylos/memory/reference/projects.md`
- `~/zylos/memory/reference/preferences.md`
- `~/zylos/memory/sessions/today.md`

### Step 4: Extract and classify

Analyze the conversation batch and extract items into categories:

| Category | Target File | Extract When... |
|----------|------------|----------------|
| **Decisions** | `reference/decisions.md` | User makes or confirms a decision ("let's do X", "yes, go with Y") |
| **Preferences** | `reference/preferences.md` | User expresses a preference ("I prefer X", "don't do Y") |
| **Project updates** | `reference/projects.md` | A project status changes (started, completed, blocked) |
| **Active state** | `core.md` | Current work focus changes, key references change |
| **Session events** | `sessions/today.md` | Significant events, completions, errors worth logging |

### Step 5: Write updates

Use the Edit tool to update each file. Follow the format rules below.

### Step 6: Create checkpoint

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js <end_id> --summary "<summary>"
```

The summary should be ~200 characters describing what was extracted.
Example: `"Decisions: use Agent Teams for research. Preferences: diary-style entries. Projects: C4 merged. Focus: memory implementation."`

### Step 7: If triggered by scheduler, mark task done

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js done <task-id>
```

## File Format Rules

### core.md

```markdown
# Core Memory

**Identity:** I am [name], [user]'s AI companion. Day N.

## User Profile
- Name: [user name]
- Communication: [channels]
- Principles: [key principles]

## Active Working State
[1-3 sentences on current focus -- UPDATE during memory sync]

## Key References
[Paths, IDs, URLs relevant to current work -- UPDATE during memory sync]

## Services
[Critical service list -- update only when services change]
```

**Budget:** Keep core.md under 3KB. Only update Active Working State and Key References sections during sync. The identity and user profile sections are stable.

### reference/decisions.md

```markdown
### [YYYY-MM-DD] Decision Title
- **Decision:** What was decided
- **Context:** Why (1 sentence)
- **Status:** active | superseded | archived
```

### reference/preferences.md

```markdown
### Preference Name
- **Value:** The preference
- **Source:** conversation / observation
- **Added:** YYYY-MM-DD
```

### reference/projects.md

```markdown
### Project Name
- **Status:** active | completed | blocked | planned
- **Updated:** YYYY-MM-DD
- **Notes:** Current state (2-3 sentences max)
```

### sessions/today.md

```markdown
# Session Log: YYYY-MM-DD

**HH:MM** - Brief description of event/completion/issue
**HH:MM** - Another event
```

## Extraction Guidelines

1. **Be selective, not exhaustive.** Not every conversation is a memory. Skip chit-chat, acknowledgments, routine operational messages, health check outputs.

2. **Prefer updates over additions.** If a decision in `decisions.md` is superseded by a new one, update the existing entry's status to `superseded` and add the new decision. Don't let files grow unboundedly.

3. **core.md is the tightest budget.** Only update if the active work focus or key references have genuinely changed. Keep under 3KB.

4. **sessions/today.md is append-only within a day.** Add timestamped entries. Never delete from today's log.

5. **When in doubt, write to sessions/today.md.** If unsure whether something is a decision, preference, or project update, log it as a session event.

6. **Handle attachment references.** If a conversation contains `[Attachment: path]`, note the path in the session log but don't inline the content.

7. **Archive old items proactively.** When a project is completed or a decision is superseded, move it to `archive/` or mark its status. This keeps reference files focused on current state.

## Diagnostic Commands

```bash
# Check memory status
node ~/zylos/.claude/skills/memory/scripts/memory-status.js

# Check C4 sync state
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js unsummarized

# List checkpoints
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js checkpoints

# Initialize memory (if files missing)
node ~/zylos/.claude/skills/memory/scripts/memory-init.js
```

## Integration with Other Components

- **C4 (comm-bridge):** Provides conversation data (c4-fetch.js) and checkpoint tracking (c4-checkpoint.js). Memory Sync reads from C4 but never writes to the conversations table.
- **C5 (scheduler):** Dispatches periodic memory sync and session rotation tasks.
- **C2 (activity-monitor):** After crash recovery, SessionStart hooks fire and re-inject core.md.
```

---

## 7. Implementation Task List

### Task 1: Create memory skill directory structure

**What to build:**
Create the skill directory and all script/template files in `skills/memory/`.

**Files to create:**

```
skills/memory/
├── SKILL.md                       # Full instructions (Section 6 content)
├── package.json                   # {"type":"module"}
├── scripts/
│   ├── memory-sync.js             # Core sync orchestration
│   ├── session-rotate.js          # Daily session log rotation
│   ├── session-inject.js          # SessionStart hook (core.md -> JSON)
│   ├── memory-status.js           # Diagnostic status output
│   ├── memory-init.js             # Initialize directory structure
│   └── register-tasks.js          # Register scheduler tasks
└── templates/
    ├── core.md                    # Template for ~/zylos/memory/core.md
    ├── decisions.md               # Template for reference/decisions.md
    ├── projects.md                # Template for reference/projects.md
    ├── preferences.md             # Template for reference/preferences.md
    └── session-day.md             # Template for sessions/today.md
```

**Estimated effort:** 3-4 hours
**Dependencies:** None (can start immediately)
**Risk level:** Low
**Acceptance criteria:**
- All files created with correct ESM syntax
- `node scripts/memory-init.js` creates directory structure and template files
- `node scripts/session-inject.js` outputs valid JSON with `additionalContext`
- `node scripts/session-rotate.js` creates/rotates session files
- `node scripts/memory-status.js` outputs formatted status report
- `package.json` has `"type": "module"`
- Zero shell scripts anywhere in the skill

---

### Task 2: Create template files

**What to build:**
Template files for memory initialization.

**templates/core.md:**
```markdown
# Core Memory

**Identity:** I am Zylos, an autonomous AI agent.

## User Profile
- Name: (to be learned)
- Communication: (to be learned)
- Principles: (to be learned)

## Active Working State
Fresh installation. Ready for first interaction.

## Key References
None yet.

## Services
(Will be populated after setup)
```

**templates/decisions.md:**
```markdown
# Decisions Log

Key decisions made during operation.

## Format

Each entry follows this structure:
### [YYYY-MM-DD] Decision Title
- **Decision:** What was decided
- **Context:** Why (1 sentence)
- **Status:** active | superseded | archived
```

**templates/projects.md:**
```markdown
# Projects

Active and planned projects.

## Active

None yet.

## Planned

None yet.

## Completed

None yet.
```

**templates/preferences.md:**
```markdown
# User Preferences

Observed preferences and settings.

## Communication
- Preferred language: (to be learned)
- Response style: (to be learned)

## Work Style
- (to be learned through interaction)
```

**templates/session-day.md:**
```markdown
# Session Log: {{DATE}}

```

**Estimated effort:** 30 minutes
**Dependencies:** None
**Risk level:** None
**Acceptance criteria:** Templates match the format rules in SKILL.md

---

### Task 3: Update templates/CLAUDE.md

**What to build:**
Update the zylos-core template CLAUDE.md to include memory system instructions.

**Changes to make:**
1. Replace the existing basic "Memory System" section with detailed instructions referencing the new file layout
2. Add memory sync trigger handling instructions
3. Reference the memory SKILL.md for full details

**Section to update (replace existing Memory System section):**

```markdown
## Memory System

Persistent memory stored in `~/zylos/memory/`:

### Always Loaded (via SessionStart hook)
- `core.md` - Identity, user profile, active working state, key references (~3KB)

### Load on Demand
- `reference/decisions.md` - Active decisions
- `reference/projects.md` - Active/planned projects
- `reference/preferences.md` - User preferences

### Session Log
- `sessions/today.md` - Current day's events (append-only)
- `sessions/YYYY-MM-DD.md` - Previous session logs

### Important Practices
1. **Start each session** - core.md is auto-injected; read reference files as needed
2. **Update memory frequently** - don't wait until context is full
3. **Before context compaction** - update memory files first

### Memory Sync
When you see `[Action Required] invoke /memory-sync --begin X --end Y`:
1. This means >30 conversations need to be processed into memory
2. Follow the memory skill instructions to process them
3. See `~/zylos/.claude/skills/memory/SKILL.md` for full workflow

### File Persistence
Memory files persist as plain files on disk. No git commits needed.
Just write the files -- they survive across sessions and compactions.
```

**Estimated effort:** 30 minutes
**Dependencies:** Task 1 (SKILL.md must be designed first)
**Risk level:** Low (the template is only used for new installations; existing instances need manual update)
**Acceptance criteria:**
- `templates/CLAUDE.md` references new file layout
- No references to git commit for memory
- Memory sync handling instructions included

---

### Task 4: Configure hooks

**What to build:**
Add `session-inject.js` to the SessionStart hook chain. Document the hook configuration in a template.

**Implementation approach:**
Create `skills/memory/templates/hooks.json` documenting the required hooks. The installer (`memory-init.js` or installation process) reads this and merges it into `~/.claude/settings.local.json`.

**Hook merge logic in memory-init.js (or separate installer script):**

```javascript
// Read existing settings.local.json
// Ensure hooks.SessionStart array exists
// Prepend session-inject.js hook if not already present
// Write back to settings.local.json
```

**Estimated effort:** 1 hour
**Dependencies:** Task 1 (session-inject.js must exist)
**Risk level:** Medium (modifying settings.local.json can break session start if JSON is malformed)
**Acceptance criteria:**
- SessionStart hook chain has `session-inject.js` as first hook
- Existing hooks (c4-session-init.js, c4-threshold-check.js) preserved
- Starting a new Claude session shows core.md content
- No references to `post-compact-inject.sh`

**Rollback:** Keep backup of `settings.local.json` before modification. Restore from backup if hooks break.

---

### Task 5: Register scheduler tasks

**What to build:**
The `register-tasks.js` script that registers all memory-related tasks with the scheduler.

**Estimated effort:** 30 minutes
**Dependencies:** Scheduler skill (C5) must be installed and running
**Risk level:** Low (adding tasks is non-destructive)
**Acceptance criteria:**
- `~/zylos/.claude/skills/scheduler/scripts/cli.js list` shows memory-sync, session-rotate, and memory-integrity tasks
- memory-sync task has priority 1
- session-rotate task runs daily at 00:05

---

### Task 6: Integration testing

**What to build:**
Manual test sequence to verify the complete system works end-to-end.

**Estimated effort:** 1-2 hours
**Dependencies:** All previous tasks
**Risk level:** N/A (testing only)
**Acceptance criteria:**
- Full sync cycle completes: fetch -> extract -> write -> checkpoint
- Session start shows core.md content
- Scheduler dispatches memory sync at correct interval and priority
- Session rotation works at day boundary

---

### Task Summary

| # | Task | Effort | Risk | Dependencies |
|---|------|--------|------|-------------|
| 1 | Create memory skill directory + scripts | 3-4h | Low | None |
| 2 | Create template files | 30m | None | None |
| 3 | Update templates/CLAUDE.md | 30m | Low | Task 1 |
| 4 | Configure hooks | 1h | Medium | Task 1 |
| 5 | Register scheduler tasks | 30m | Low | C5 installed |
| 6 | Integration testing | 1-2h | N/A | All above |

**Total estimated effort: 6-8 hours**

---

## 8. Migration Strategy

### 8.1 For New Zylos Installations

No migration needed. The installation process (`zylos add memory` or initial setup) runs `memory-init.js`, which:
1. Creates the directory structure (`~/zylos/memory/reference/`, `sessions/`, `archive/`)
2. Copies template files to the memory directory
3. Merges hooks into `settings.local.json`
4. Registers scheduler tasks

### 8.2 For Existing Zylos Instances (Migration from v1 layout)

The existing instance (Howard's current setup) has flat memory files:
```
~/zylos/memory/
├── context.md        (9.3 KB)
├── decisions.md      (14 KB)
├── projects.md       (9.2 KB)
├── preferences.md    (1.9 KB)
└── building-ideas.md (2 KB)
```

**Migration steps (ordered, each independently reversible):**

#### Step 1: Create new directories

```bash
mkdir -p ~/zylos/memory/reference
mkdir -p ~/zylos/memory/sessions
mkdir -p ~/zylos/memory/archive
```

**Rollback:** `rm -rf ~/zylos/memory/reference ~/zylos/memory/sessions ~/zylos/memory/archive`

#### Step 2: Move reference files

```bash
cp ~/zylos/memory/decisions.md ~/zylos/memory/reference/decisions.md
cp ~/zylos/memory/projects.md ~/zylos/memory/reference/projects.md
cp ~/zylos/memory/preferences.md ~/zylos/memory/reference/preferences.md
cp ~/zylos/memory/building-ideas.md ~/zylos/memory/reference/ideas.md
```

Use `cp` not `mv` -- keep originals until migration is verified. Remove originals after verification.

**Pass/fail:** `cat ~/zylos/memory/reference/decisions.md` shows content.

#### Step 3: Create core.md from context.md

Claude reads `context.md` (9.3KB) and extracts:
- **Stable identity sections** (user profile, principles, services) -> `core.md`
- **Current work focus** -> `core.md` Active Working State section (condensed)
- **Session-specific content** (recent activity, active tasks) -> `sessions/today.md`
- **Project notes embedded in context.md** -> appropriate `reference/` file

The goal is to split the monolithic context.md into the tiered structure. `core.md` must be under 3KB.

**Pass/fail:** `wc -c ~/zylos/memory/core.md` shows < 3072 bytes. `cat ~/zylos/memory/core.md` shows the Core Memory template structure with populated content.

#### Step 4: Handle legacy files

```bash
# Move _archive/ contents to archive/ if they exist
# Keep context.md as-is for backward compatibility during transition
# After 1 week of stable operation, remove old flat files
```

#### Step 5: Deploy memory skill

Copy the updated `skills/memory/` from zylos-core to `~/.claude/skills/memory/`:
- The skill is part of zylos-core, so `zylos upgrade zylos-core` will pull it
- Or manually: `cp -r ~/zylos/zylos-core/skills/memory/ ~/zylos/.claude/skills/memory/`

**Pass/fail:** `cat ~/zylos/.claude/skills/memory/SKILL.md` shows full v2 content.

#### Step 6: Update hooks

1. Back up: `cp ~/.claude/settings.local.json ~/.claude/settings.local.json.bak`
2. Run hook configuration (either via `memory-init.js` or manual edit)
3. Verify: Start a new Claude session and confirm core.md content appears

**Rollback:** `cp ~/.claude/settings.local.json.bak ~/.claude/settings.local.json`

**Pass/fail:** New Claude session shows `=== CORE MEMORY ===` content.

#### Step 7: Register scheduler tasks

```bash
node ~/zylos/.claude/skills/memory/scripts/register-tasks.js
```

**Pass/fail:** `~/zylos/.claude/skills/scheduler/scripts/cli.js list` shows memory-sync at priority 1.

#### Step 8: Verify full sync cycle

1. Check unsummarized count: `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js unsummarized`
2. If count > 0, invoke `/memory-sync --begin X --end Y`
3. Verify: memory files updated, checkpoint created
4. Start new session, verify checkpoint summary appears

**Pass/fail:** New session shows `[Last Checkpoint Summary]` with the sync's summary text.

### 8.3 What Files to Create/Modify in zylos-core Repo

| Action | Path | Description |
|--------|------|-------------|
| **Replace** | `skills/memory/SKILL.md` | Full v2 skill instructions |
| **Create** | `skills/memory/package.json` | `{"type":"module"}` |
| **Create** | `skills/memory/scripts/memory-sync.js` | Sync orchestration |
| **Create** | `skills/memory/scripts/session-rotate.js` | Daily rotation |
| **Create** | `skills/memory/scripts/session-inject.js` | SessionStart hook |
| **Create** | `skills/memory/scripts/memory-status.js` | Diagnostic output |
| **Create** | `skills/memory/scripts/memory-init.js` | Directory initialization |
| **Create** | `skills/memory/scripts/register-tasks.js` | Scheduler task registration |
| **Create** | `skills/memory/templates/core.md` | Core memory template |
| **Update** | `skills/memory/templates/decisions.md` | (exists in templates/memory/, move here) |
| **Update** | `skills/memory/templates/projects.md` | (exists in templates/memory/, move here) |
| **Update** | `skills/memory/templates/preferences.md` | (exists in templates/memory/, move here) |
| **Create** | `skills/memory/templates/session-day.md` | Session log template |
| **Create** | `skills/memory/templates/hooks.json` | Hook configuration template |
| **Modify** | `templates/CLAUDE.md` | Add memory system instructions |

**No changes to:**
- `skills/comm-bridge/` (all C4 scripts remain untouched)
- `skills/scheduler/` (scheduler is used as-is via CLI)
- `templates/pm2/ecosystem.config.cjs` (no new PM2 services for memory)

### 8.4 How Deployment Works

Zylos-core uses a component model:
1. Skills live in `skills/<name>/` in the zylos-core repo
2. During installation, skills are symlinked or copied to `~/.claude/skills/<name>/`
3. Runtime data goes to `~/zylos/<name>/` (in this case, `~/zylos/memory/`)
4. Templates in `templates/` are processed during initial setup

When `zylos add memory` or `zylos upgrade` runs:
1. Copies `skills/memory/` to `~/.claude/skills/memory/`
2. Runs `npm install` in the skill directory (for any dependencies in package.json)
3. Runs `memory-init.js` to create the runtime directory structure
4. Optionally runs `register-tasks.js` to set up scheduler tasks
5. Merges hooks from `templates/hooks.json` into `settings.local.json`

---

## 9. Testing Strategy

### 9.1 Unit Tests for Each Script

| Script | Test | Input | Expected Output |
|--------|------|-------|----------------|
| **session-inject.js** | No core.md | Delete core.md, run script | `{"additionalContext":""}` (valid JSON, empty) |
| **session-inject.js** | With core.md | Create core.md with test content | `{"additionalContext":"=== CORE MEMORY ...\n<content>\n..."}` |
| **session-inject.js** | Malformed core.md | Binary content in core.md | Script doesn't crash, outputs valid JSON |
| **session-rotate.js** | No today.md | Delete today.md, run script | Creates `sessions/today.md` with today's date header |
| **session-rotate.js** | Same day | Run twice on same day | Second run: "No rotation needed" |
| **session-rotate.js** | Day change | Set today.md date to yesterday | Renames to `YYYY-MM-DD.md`, creates fresh today.md |
| **session-rotate.js** | No sessions dir | Delete sessions/, run script | Creates directory and today.md |
| **memory-sync.js** | --status | Run with --status | JSON output with unsummarized count |
| **memory-sync.js** | Valid range | --begin 1 --end 5 | Formatted conversations + memory state |
| **memory-sync.js** | Missing args | No args | Error message and exit code 1 |
| **memory-init.js** | Fresh install | Empty ~/zylos/memory/ | Creates dirs and template files |
| **memory-init.js** | Existing files | Files already exist with content | Skips existing files (idempotent) |
| **memory-status.js** | Normal state | Memory files exist, C4 DB has data | Formatted status report |
| **memory-status.js** | No C4 DB | C4 DB doesn't exist | Graceful degradation, shows file info only |

### 9.2 Unit Test Execution

Each test can be run manually:

```bash
# Test session-inject.js output is valid JSON
node ~/zylos/.claude/skills/memory/scripts/session-inject.js | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const output = Buffer.concat(chunks).toString();
    try {
      const parsed = JSON.parse(output);
      console.log('PASS: Valid JSON');
      console.log('Has additionalContext:', 'additionalContext' in parsed);
    } catch (e) {
      console.log('FAIL: Invalid JSON:', e.message);
      process.exit(1);
    }
  });
"

# Test session-rotate.js idempotency
node ~/zylos/.claude/skills/memory/scripts/session-rotate.js
node ~/zylos/.claude/skills/memory/scripts/session-rotate.js
# Second run should say "No rotation needed"

# Test memory-init.js idempotency
node ~/zylos/.claude/skills/memory/scripts/memory-init.js
node ~/zylos/.claude/skills/memory/scripts/memory-init.js
# Second run should say "Skipped (exists)" for all files
```

### 9.3 Integration Test: Full Sync Cycle

**Prerequisites:**
- C4 comm-bridge installed and running
- At least 1 conversation in C4 DB
- Memory files initialized

**Test steps:**

1. **Check unsummarized conversations exist:**
   ```bash
   node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js unsummarized
   ```
   Expected: `{ "count": N, "begin_id": X, "end_id": Y }` where N > 0

2. **Run memory-sync.js to verify data retrieval:**
   ```bash
   node ~/zylos/.claude/skills/memory/scripts/memory-sync.js --begin X --end Y
   ```
   Expected: Formatted conversation output + memory state summaries

3. **Invoke the full memory skill:**
   In a Claude session, trigger: `/memory-sync --begin X --end Y`
   Expected: Claude follows SKILL.md instructions, reads conversations, updates memory files, creates checkpoint

4. **Verify memory files were updated:**
   ```bash
   ls -la ~/zylos/memory/core.md
   ls -la ~/zylos/memory/sessions/today.md
   ```
   Expected: Recent modification timestamps

5. **Verify checkpoint was created:**
   ```bash
   node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js checkpoints
   ```
   Expected: New checkpoint with end_conversation_id = Y

6. **Start new session and verify:**
   Start a fresh Claude session.
   Expected:
   - `=== CORE MEMORY ===` content appears (from session-inject.js)
   - `[Last Checkpoint Summary]` shows the sync's summary text (from c4-session-init.js)
   - No Memory Sync trigger (if all conversations are now summarized)

### 9.4 Integration Test: Scheduler Dispatch

1. **Verify memory-sync task is registered:**
   ```bash
   ~/zylos/.claude/skills/scheduler/scripts/cli.js list
   ```
   Expected: memory-sync task with priority 1

2. **Force-trigger by setting next_run to now:**
   ```bash
   ~/zylos/.claude/skills/scheduler/scripts/cli.js update <task-id> --in "10 seconds"
   ```

3. **Wait and verify dispatch:**
   Watch scheduler logs: `pm2 logs scheduler`
   Expected: "Dispatching task: <task-id> (memory-sync)"

4. **Verify C4 queue priority:**
   Check C4 DB for the dispatched message's priority:
   Expected: priority = 1

### 9.5 Integration Test: Hook Chain

1. **Start a fresh Claude session**
2. **Verify session-inject.js ran:**
   Claude should have core.md content in context
3. **Verify c4-session-init.js ran:**
   Claude should see checkpoint summary or "No new conversations"
4. **Send a message and verify threshold check:**
   Send any message; if >30 unsummarized conversations, Claude should see Memory Sync trigger

### 9.6 Simulating the Flow Locally

For development testing without a live Claude session:

```bash
# 1. Initialize memory
node skills/memory/scripts/memory-init.js

# 2. Verify session-inject output
node skills/memory/scripts/session-inject.js
# Should output valid JSON

# 3. Verify session-rotate
node skills/memory/scripts/session-rotate.js
cat ~/zylos/memory/sessions/today.md
# Should show today's date

# 4. Verify memory-status
node skills/memory/scripts/memory-status.js
# Should show file sizes and C4 status

# 5. Verify memory-sync (requires C4 DB)
node skills/memory/scripts/memory-sync.js --status
# Should show unsummarized count
```

### 9.7 Test Checklist (Post-Deployment)

- [ ] `node session-inject.js` outputs valid JSON with core.md content
- [ ] `node session-rotate.js` creates/rotates session files correctly
- [ ] `node memory-sync.js --status` shows C4 sync status
- [ ] `node memory-init.js` is idempotent (safe to run multiple times)
- [ ] Starting a new Claude session shows `=== CORE MEMORY ===`
- [ ] Starting a new Claude session shows `[Last Checkpoint Summary]`
- [ ] Memory Sync trigger appears when >30 unsummarized conversations
- [ ] Full sync cycle: conversations -> memory files -> checkpoint
- [ ] Scheduler dispatches memory-sync at priority 1
- [ ] Scheduler dispatches session-rotate daily
- [ ] Memory files persist after context compaction (no git needed)
- [ ] No shell scripts (.sh) exist in the memory skill directory

---

## Appendix A: Complete File Manifest

### Files in zylos-core repository

```
skills/memory/
├── SKILL.md                          # 6 KB  - Full Claude instructions
├── package.json                      # 0.1 KB - {"type":"module"}
├── scripts/
│   ├── memory-sync.js                # 2 KB  - Fetch conversations, format for Claude
│   ├── session-rotate.js             # 1.5 KB - Rotate daily session log
│   ├── session-inject.js             # 1 KB  - SessionStart hook (core.md -> JSON)
│   ├── memory-status.js              # 2 KB  - Diagnostic status output
│   ├── memory-init.js                # 2 KB  - Initialize directory structure
│   └── register-tasks.js             # 1.5 KB - Register scheduler tasks
└── templates/
    ├── core.md                        # 0.3 KB - Core memory template
    ├── decisions.md                   # 0.2 KB - Decisions template
    ├── projects.md                    # 0.1 KB - Projects template
    ├── preferences.md                 # 0.2 KB - Preferences template
    ├── session-day.md                 # 0.1 KB - Session log template
    └── hooks.json                     # 0.3 KB - Hook configuration template

templates/CLAUDE.md                   # Modified - Memory system section updated
```

### Runtime files at ~/zylos/memory/ (deployed instance)

```
~/zylos/memory/
├── core.md                           # Identity + active state (always loaded)
├── reference/
│   ├── decisions.md                  # Active decisions
│   ├── projects.md                   # Active projects
│   ├── preferences.md                # User preferences
│   └── ideas.md                      # Building ideas (optional)
├── sessions/
│   ├── today.md                      # Current day's log
│   ├── 2026-02-06.md                 # Yesterday's log (rotated)
│   └── ...                           # Previous days
└── archive/                          # Cold storage (initially empty)
```

## Appendix B: Comparison with v1

| Aspect | v1 | v2 |
|--------|----|----|
| Memory persistence | Git commit via `memory-commit.sh` | Plain files on disk, no git |
| Shell scripts | `memory-commit.sh` (bash) | Zero shell scripts, all Node.js ESM |
| Hook injection | `post-compact-inject.sh` (zylos-personal) | `session-inject.js` (Node.js, native hooks) |
| Memory sync priority | Priority 3 (normal, same as user msgs) | Priority 1 (urgent, above user msgs) |
| Scheduler integration | None | Full integration (3 scheduled tasks) |
| Skill location | `skills/memory-sync/` (new skill) | `skills/memory/` (replaces existing placeholder) |
| CLAUDE.md template | Not modified | Updated with memory instructions |
| Project base | Mixed zylos-personal references | zylos-core only |

## Appendix C: Dependency Map

```
Memory Skill (NEW)
├── scripts/session-inject.js     ──── SessionStart hook
│   └── Reads: ~/zylos/memory/core.md
│
├── scripts/memory-sync.js        ──── Called by Claude during sync
│   ├── Calls: c4-fetch.js (comm-bridge)
│   └── Reads: ~/zylos/memory/*.md
│
├── scripts/session-rotate.js     ──── Called by scheduler (daily)
│   └── Writes: ~/zylos/memory/sessions/
│
├── scripts/memory-status.js      ──── Diagnostic
│   ├── Reads: ~/zylos/memory/*.md
│   └── Calls: c4-db.js (comm-bridge)
│
├── scripts/memory-init.js        ──── Installation
│   └── Writes: ~/zylos/memory/ (dirs + templates)
│
└── scripts/register-tasks.js     ──── Installation
    └── Calls: scheduler/scripts/cli.js (scheduler)

Existing Components (NO changes):
├── comm-bridge/scripts/c4-fetch.js          # Read conversations
├── comm-bridge/scripts/c4-checkpoint.js     # Mark sync boundary
├── comm-bridge/scripts/c4-session-init.js   # SessionStart hook (after session-inject)
├── comm-bridge/scripts/c4-threshold-check.js # UserPromptSubmit hook
├── comm-bridge/scripts/c4-receive.js        # Incoming messages (used by scheduler)
├── scheduler/scripts/daemon.js              # Task dispatch
└── scheduler/scripts/cli.js                 # Task management
```
