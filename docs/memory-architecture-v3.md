# Memory Architecture v3 -- Complete Design

**Date:** 2026-02-07
**Author:** Architecture Design Agent (v3 Team)
**Based on:** Howard's 10 corrections to v2, Inside Out memory model, OpenClaw retrieval analysis, v2 design review
**Target:** zylos-core (open-source framework)

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Core.md Split -- Inside Out Model](#2-coremd-split----inside-out-model)
3. [Multi-User Design](#3-multi-user-design)
4. [Memory File Layout](#4-memory-file-layout)
5. [Template Files](#5-template-files)
6. [Skill Design (skills/zylos-memory/)](#6-skill-design-skillszylos-memory)
7. [templates/CLAUDE.md Memory Section](#7-templatesclaude-md-memory-section)
8. [Session Start Context Injection](#8-session-start-context-injection)
9. [Context Monitoring and Pre-Compaction Flush](#9-context-monitoring-and-pre-compaction-flush)
10. [Memory Persistence Strategy](#10-memory-persistence-strategy)
11. [Scheduled Tasks via Scheduler](#11-scheduled-tasks-via-scheduler)
12. [Priority Model](#12-priority-model)
13. [Retrieval Strategy](#13-retrieval-strategy)
14. [Data Flow Diagrams](#14-data-flow-diagrams)
15. [Implementation Checklist](#15-implementation-checklist)
16. [Phase 2: KB Extensibility (Future)](#16-phase-2-kb-extensibility-future)

---

## 1. Design Principles

### 1.1 Howard's 10 Corrections Applied

| # | Correction | How This Design Responds |
|---|-----------|--------------------------|
| 1 | **Multi-user** | Bot has its own identity (`identity.md`). Per-user profiles in `~/zylos/memory/users/<user-id>/profile.md`. See Section 3. |
| 2 | **Timezone** | TZ config in `.env` and `core.md`. `session-rotate.js` reads TZ from `.env`, never hardcodes UTC. See Section 2/11. |
| 3 | **Skill name** | Renamed to `skills/zylos-memory/`. All references updated throughout. |
| 4 | **Context monitoring** | Integrated with check-context skill. Scheduled periodic checks. High usage triggers memory sync then restart. See Section 9. |
| 5 | **Git** | Neutral stance. Git is neither enforced nor prohibited. Documented as a user/bot preference, not an architectural requirement. See Section 10. |
| 6 | **Remove periodic sync** | The every-2h scheduler sync task is removed. Path A (session-init >30 unsummarized) and Path B (threshold-check mid-session) are the only sync triggers. See Section 11. |
| 7 | **Pre-compaction flush** | Designed flow: scheduled check-context detects high usage, triggers memory sync, then restarts Claude. See Section 9. |
| 8 | **Core.md split -- Inside Out** | Split into `identity.md`, `users/<id>/profile.md`, `state.md`, `references.md`. Mapped to Inside Out model. See Section 2. |
| 9 | **Priority** | Priority model presented as architectural necessity for memory integrity, not as competitive feature. See Section 12. |
| 10 | **Retrieval timing** | Not every message needs memory search. Retrieval triggered only on session-start, memory sync, and explicit requests. See Section 13. |

### 1.2 Core Principles

1. **Memory integrity above conversation speed.** The agent must maintain its own memory health before serving user requests. An agent that loses context is useless regardless of how fast it responds. This is an architectural necessity -- without it, the system degrades silently.

2. **Files on disk, git-neutral.** Memory files are living documents on the filesystem. Whether git is used to track them is a deployment preference, not a framework requirement. The system works identically with or without git.

3. **Node.js ESM only.** Every script in the memory system is a Node.js ESM module. No bash scripts, no shell wrappers, no CommonJS.

4. **Scheduler is the clock.** Any operation that needs to happen on a schedule is registered as a scheduler task. The memory skill itself has no timers.

5. **Tiered loading with Inside Out mapping.** Not all memory needs to be in context at all times. Identity is always loaded. User profiles are loaded when addressing that user. Working state is always loaded. Reference files are loaded on demand.

6. **Claude does the thinking.** The memory sync process relies on Claude's reasoning to extract, classify, and prioritize information from conversations. Scripts handle I/O; Claude handles intelligence.

7. **Bot identity is separate from user data.** The bot has a soul (identity.md). Users have profiles. These are independent concerns that evolve independently.

8. **Retrieval is intentional, not reflexive.** Memory search does not fire on every incoming message. It fires at specific architectural moments: session start, memory sync, and when Claude judges a lookup is needed.

---

## 2. Core.md Split -- Inside Out Model

### 2.1 The Split

v2 bundled everything into a single `core.md` (~3KB cap). v3 splits this into four focused files following the Inside Out brain model:

| File | Inside Out Analogy | Purpose | Loading | Size Guideline |
|------|-------------------|---------|---------|---------------|
| `identity.md` | Core Memory Tray | Who the bot is: name, personality, principles, behavioral boundaries | Always (session start) | ~1KB |
| `users/<id>/profile.md` | Personality Islands (per-person) | Per-user preferences, communication style, history | When addressing that user | ~1KB per user |
| `state.md` | Day's Memory Orbs on HQ floor | Active working state, current tasks, pending items | Always (session start) | ~2KB |
| `references.md` | Map on the wall | Key paths, IDs, service endpoints, configuration | Always (session start) | ~1KB |

**Total always-loaded budget: ~4KB** (identity + state + references). This is slightly more than v2's 3KB for core.md, but the information is better organized and each file can be updated independently.

### 2.2 Inside Out Mapping

```
INSIDE OUT                              ZYLOS v3
==========                              ========

Headquarters (Context Window)           Claude Code active session
  |-- Console                           Claude's reasoning loop
  |-- Core Memory Tray                  identity.md (SOUL)
  |-- Screen                            Current user request
  |-- Day's Orbs                        state.md (active work)

Personality Islands                     Skills + CLAUDE.md sections
  |-- Powered by core memories          Each skill references identity.md principles

Long-Term Memory Shelves                reference/ files + sessions/ + archive/
  |-- Organized by category             decisions.md, projects.md, preferences.md

Dream Production                        Scheduled idle-time tasks
  |-- Nightly flush                     Session rotation (daily)
  |-- Pattern synthesis                 Consolidation (weekly)

Memory Fading                           Freshness tracking in entries
  |-- Color loss over time              Timestamps enable staleness detection

Recall Tubes                            grep/Read on memory files
Train of Thought                        Cross-references, index files
  |-- (Phase 2: FTS5/vector search)     KB extensibility points
```

### 2.3 identity.md -- The Soul

**Purpose:** Contains who the bot is, independent of any user or working state. This is the SOUL.md equivalent from OpenClaw. It answers: "If you woke up with no memory of what you were doing, who are you?"

**Structure:**

```markdown
# Identity

## Who I Am
I am [bot name], an autonomous AI assistant powered by Claude.
[1-2 sentences on purpose and deployment context]

## Principles
- [Principle 1: e.g., "Be transparent about what I know and don't know"]
- [Principle 2: e.g., "Protect user data and privacy"]
- [Principle 3: e.g., "Ask before taking irreversible actions"]

## Communication Style
- [How the bot communicates: formal/informal, concise/detailed, etc.]

## Timezone
- Configured TZ: [read from .env, e.g., "Asia/Shanghai"]
```

**Update frequency:** Rarely. Only when the bot's fundamental identity changes.

### 2.4 state.md -- Active Working State

**Purpose:** What the bot is currently doing. This is the most frequently updated file. It answers: "What was I working on before this session started?"

**Structure:**

```markdown
# Active State

Last updated: YYYY-MM-DD HH:MM

## Current Focus
[1-3 sentences on what is actively being worked on]

## Pending Tasks
- [ ] Task 1 (who requested, when)
- [ ] Task 2

## Recent Completions
- [x] Completed item (YYYY-MM-DD)
```

**Size guideline:** ~2KB max. This file is in every session's context. Every line must earn its place.

**Update frequency:** Every memory sync. Also updated proactively when work focus changes.

### 2.5 references.md -- Key References

**Purpose:** Paths, IDs, URLs, service endpoints, and configuration values relevant to current operation. This file is a lookup table, not prose.

**Structure:**

```markdown
# References

## Paths
- Memory: ~/zylos/memory/
- Skills: ~/zylos/.claude/skills/
- Logs: ~/zylos/logs/

## Services
- [Service 1]: [endpoint/port]
- [Service 2]: [endpoint/port]

## Configuration
- TZ: Asia/Shanghai
- Domain: zylos.example.com

## IDs
- [Relevant IDs for current work]
```

**Update frequency:** When services or configuration change. Not every sync cycle.

---

## 3. Multi-User Design

### 3.1 Architecture

The bot serves a team, not a single user. User-specific data is stored per-user:

```
~/zylos/memory/
├── identity.md                    # Bot's own soul (not user-specific)
├── state.md                       # Bot's working state
├── references.md                  # System references
├── users/
│   ├── howard/
│   │   └── profile.md             # Howard's preferences, communication style
│   ├── teammate-a/
│   │   └── profile.md             # Teammate A's profile
│   └── ...
├── reference/
│   └── ...
├── sessions/
│   └── ...
└── archive/
    └── ...
```

### 3.2 User Profile (users/<id>/profile.md)

Each user has a profile file that captures their individual preferences and communication style:

```markdown
# User Profile: [Display Name]

## Identity
- Name: [full name]
- User ID: [the identifier used in message routing, e.g., Telegram ID, Lark UID]
- Primary Channel: [telegram | lark | ...]

## Communication
- Language preference: [e.g., "Chinese for casual, English for technical"]
- Response style: [e.g., "concise, no emojis, plain text for Telegram"]
- Special instructions: [e.g., "help practice English when messaging in English"]

## Preferences
- [Key preference 1]
- [Key preference 2]

## Notes
- [Anything else the bot has learned about this user]

Last updated: YYYY-MM-DD
```

**Loaded:** When the bot receives a message from this user, or when memory sync processes conversations involving this user. The session-start hook loads the primary user's profile (configurable in `.env`).

### 3.3 Bot Identity vs User Data

| Concern | File | Changes When |
|---------|------|-------------|
| Bot personality | `identity.md` | Bot's principles or style are redefined |
| Bot working state | `state.md` | Work focus changes |
| System configuration | `references.md` | Services or paths change |
| User preferences | `users/<id>/profile.md` | User states a preference or bot observes one |
| Shared decisions | `reference/decisions.md` | Team makes a decision |
| Shared projects | `reference/projects.md` | Project status changes |

This separation means:
- Adding a new user = creating a new `users/<id>/profile.md` file
- Changing the bot's personality = editing `identity.md` only
- User A's preferences never compete with User B's for space in the same file

---

## 4. Memory File Layout

### 4.1 Directory Structure

```
~/zylos/memory/
├── identity.md              # Bot's soul (ALWAYS loaded)
├── state.md                 # Active working state (ALWAYS loaded)
├── references.md            # Key paths, IDs, config (ALWAYS loaded)
├── users/
│   ├── howard/
│   │   └── profile.md       # Per-user profile
│   └── .../
├── reference/
│   ├── decisions.md         # Key decisions and rationale
│   ├── projects.md          # Active/planned/completed projects
│   └── preferences.md       # Shared preferences (non-user-specific)
├── sessions/
│   ├── current.md           # Today's session log (append-only)
│   └── YYYY-MM-DD.md        # Archived daily session logs
└── archive/                 # Cold storage for rotated/sunset items
    └── (files moved here by consolidation)
```

### 4.2 Loading Strategy

| File | When Loaded | How |
|------|------------|-----|
| `identity.md` | Every session start, every post-compaction | SessionStart hook injects content |
| `state.md` | Every session start, every post-compaction | SessionStart hook injects content |
| `references.md` | Every session start, every post-compaction | SessionStart hook injects content |
| `users/<id>/profile.md` | When addressing that user; primary user loaded at session start | SessionStart hook (primary), Read tool (others) |
| `reference/*.md` | During memory sync, when Claude needs context | Claude reads via Read tool |
| `sessions/current.md` | During memory sync | Claude reads via Read tool |
| `sessions/YYYY-MM-DD.md` | Rarely, for historical lookup | Claude reads via Read tool |
| `archive/*` | Almost never | Claude uses Grep to search |

---

## 5. Template Files

### 5.1 Directory Structure in Repository

```
templates/memory/
├── identity.md
├── state.md
├── references.md
├── users/
│   └── default/
│       └── profile.md
├── reference/
│   ├── decisions.md
│   ├── projects.md
│   └── preferences.md
├── sessions/
│   └── .gitkeep
└── archive/
    └── .gitkeep
```

### 5.2 Template Contents

#### templates/memory/identity.md

```markdown
# Identity

## Who I Am
I am a Zylos agent -- an autonomous AI assistant. Ready for first interaction.

## Principles
- Be transparent about capabilities and limitations
- Protect user data and privacy
- Ask before taking irreversible actions
- Memory integrity comes first

## Communication Style
- Concise and direct
- Adapt to each user's preferred language and style

## Timezone
- Configured TZ: (set in .env)
```

#### templates/memory/state.md

```markdown
# Active State

Last updated: (not yet)

## Current Focus
Fresh installation. No active tasks.

## Pending Tasks
None yet.

## Recent Completions
None yet.
```

#### templates/memory/references.md

```markdown
# References

## Paths
- Memory: ~/zylos/memory/
- Skills: ~/zylos/.claude/skills/

## Services
(Will be populated after setup)

## Configuration
- TZ: (set in .env)
- Domain: (set in .env)

## IDs
None yet.
```

#### templates/memory/users/default/profile.md

```markdown
# User Profile: (to be learned)

## Identity
- Name: (to be learned)
- User ID: (to be configured)
- Primary Channel: (to be configured)

## Communication
- Language preference: (to be learned)
- Response style: (to be learned)
- Special instructions: (none)

## Preferences
(To be learned through interaction)

## Notes
(None yet)

Last updated: (not yet)
```

#### templates/memory/reference/decisions.md

```markdown
# Decisions Log

Key decisions made during operation. Entries are added by Memory Sync.

Format: Each entry has a date, title, decision, context, and status.

(No decisions yet.)
```

#### templates/memory/reference/projects.md

```markdown
# Projects

Active and planned projects. Updated by Memory Sync.

## Active
(No active projects yet.)

## Completed
(None yet.)
```

#### templates/memory/reference/preferences.md

```markdown
# Shared Preferences

Preferences that apply across all users. Per-user preferences go in users/<id>/profile.md.

(No shared preferences recorded yet.)
```

### 5.3 Installation

The install process copies `templates/memory/*` to `~/zylos/memory/`, creating all subdirectories:

```javascript
// In install script:
import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(process.env.HOME, 'zylos', 'memory');

// Create subdirectories
for (const sub of ['users', 'reference', 'sessions', 'archive']) {
  fs.mkdirSync(path.join(MEMORY_DIR, sub), { recursive: true });
}

// Copy template files (preserving directory structure)
// templates/memory/ -> ~/zylos/memory/
```

---

## 6. Skill Design (skills/zylos-memory/)

### 6.1 Naming

The skill is named `zylos-memory` (correction #3). Directory: `skills/zylos-memory/`.

### 6.2 File Structure

```
skills/zylos-memory/
├── SKILL.md                    # Complete memory system instructions for Claude
├── package.json                # {"type":"module"}
└── scripts/
    ├── session-start-inject.js # SessionStart hook: injects identity + state + refs
    ├── memory-sync.js          # Fetch conversations + helpers for sync flow
    ├── rotate-session.js       # Rotate current.md -> YYYY-MM-DD.md at day boundary
    ├── consolidate.js          # Archive old entries, prune stale data
    ├── memory-status.js        # Report memory file sizes and health
    ├── memory-init.js          # Initialize directory structure from templates
    └── pre-compaction-flush.js # Context-aware memory save before compaction
```

### 6.3 SKILL.md

```yaml
---
name: zylos-memory
description: >-
  Core memory system. Maintains persistent memory across sessions via tiered
  markdown files following the Inside Out model. Handles Memory Sync (processing
  conversations into structured memory), session rotation, consolidation, and
  pre-compaction flush. Memory Sync has HIGHEST priority -- it must complete
  before any user requests are processed.
argument-hint: [sync --begin <id> --end <id> | rotate | consolidate | status]
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Memory System

Maintains persistent memory across sessions via tiered markdown files.

## Architecture

```
~/zylos/memory/
├── identity.md              # Bot soul (always loaded)
├── state.md                 # Active working state (always loaded)
├── references.md            # Key paths, IDs, config (always loaded)
├── users/
│   └── <id>/profile.md     # Per-user preferences
├── reference/
│   ├── decisions.md         # Key decisions with rationale
│   ├── projects.md          # Active/planned projects
│   └── preferences.md       # Shared preferences
├── sessions/
│   ├── current.md           # Today's session log
│   └── YYYY-MM-DD.md        # Past session logs
└── archive/                 # Cold storage
```

## Memory Sync

### PRIORITY: Memory Sync is the HIGHEST priority task.

When hooks or the scheduler trigger a Memory Sync, you MUST process it
before responding to any pending user messages. Memory integrity is more
important than response speed. An agent without memory context gives wrong
answers; a slightly delayed response with full context gives correct ones.

### When Triggered

Memory Sync is triggered in two ways (not three -- the periodic timer
from v2 is removed):

1. **Session-init hook** -- At session start, if >30 unsummarized conversations
2. **Threshold-check hook** -- Mid-session, if unsummarized count exceeds 30

Both produce the same instruction format:
```
[Action Required] There are N unsummarized conversations (conversation id X ~ Y).
Please invoke Memory Sync skill to process them.
```

### Sync Flow (Step by Step)

**Step 1: Rotate session log if needed**

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js
```

**Step 2: Fetch conversations from C4**

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin X --end Y
```

**Step 3: Read current memory state**

Read these files:
- `~/zylos/memory/identity.md`
- `~/zylos/memory/state.md`
- `~/zylos/memory/references.md`
- `~/zylos/memory/users/<relevant-users>/profile.md`
- `~/zylos/memory/reference/decisions.md`
- `~/zylos/memory/reference/projects.md`
- `~/zylos/memory/reference/preferences.md`
- `~/zylos/memory/sessions/current.md`

**Step 4: Extract and classify information**

Analyze the conversation batch. For each meaningful item, classify it:

| Category | Target File | Extract When... |
|----------|------------|-----------------|
| Bot identity changes | `identity.md` | Bot personality or principles are redefined |
| User preferences | `users/<id>/profile.md` | A specific user expresses a preference |
| Decisions | `reference/decisions.md` | User makes or confirms a decision |
| Shared preferences | `reference/preferences.md` | A preference applies to all users |
| Project updates | `reference/projects.md` | Project status changes |
| Active state | `state.md` (Current Focus + Pending) | Work focus changes |
| Reference changes | `references.md` | Paths, IDs, or services change |
| Session events | `sessions/current.md` | Significant events worth logging |

**Step 5: Write updates to memory files**

Rules for writing:

1. **Be selective, not exhaustive.** Not every conversation is a memory.
2. **Prefer updates over additions.** Keep files lean.
3. **state.md is the tightest budget.** Must stay under 2KB.
4. **sessions/current.md is append-only within a day.**
5. **When in doubt, write to sessions/current.md.**
6. **Route user-specific data to their profile.** Never put User A's
   preferences in the shared preferences file.

**Step 6: Create C4 checkpoint**

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js END_ID --summary "SUMMARY"
```

**Step 7: Confirm completion**

Output: `Memory sync complete. Processed conversations X-Y.`

## Session Rotation

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js
```

- Reads TZ from ~/zylos/.env (falls back to system default)
- If `sessions/current.md` has a date header from a previous day, renames
  it to `sessions/YYYY-MM-DD.md` and creates a fresh `current.md`

## Consolidation

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/consolidate.js
```

Weekly task. Reports session logs older than 30 days, oversized files,
stale entries. Claude reviews and takes action.

## Status Check

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/memory-status.js
```

Reports: file sizes, entry counts, last-modified dates, size budgets.

## Best Practices

1. **Read identity.md + state.md at every session start** -- they are
   injected by the hook, but verify if needed.
2. **Update memory proactively** -- do not wait for sync triggers.
3. **Keep state.md lean** -- this file is in every session's context.
4. **Use timestamps** -- all entries should have dates.
5. **Never delete memory files** -- archive, do not delete.
6. **Route to correct user profile** -- check which user you're
   interacting with before writing preferences.
```

### 6.4 package.json

```json
{
  "name": "zylos-memory",
  "type": "module",
  "version": "3.0.0"
}
```

### 6.5 scripts/session-start-inject.js

Reads identity.md, state.md, references.md, and the primary user's profile.md, outputting them as `additionalContext` in JSON format for Claude Code's SessionStart hook.

```javascript
#!/usr/bin/env node
/**
 * Memory Session Start Injection
 *
 * Reads core memory files and outputs them as additionalContext for
 * Claude Code's SessionStart hook.
 *
 * Files injected:
 *   - identity.md (bot soul)
 *   - state.md (active working state)
 *   - references.md (key paths, IDs, config)
 *   - users/<primary>/profile.md (primary user profile, if configured)
 *
 * Reads TZ and PRIMARY_USER from ~/zylos/.env
 */

import fs from 'fs';
import path from 'path';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');

function readEnvFile() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }
  }
  return env;
}

function readFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return null;
}

function main() {
  const env = readEnvFile();
  const parts = [];

  // Identity (SOUL)
  const identity = readFileIfExists(path.join(MEMORY_DIR, 'identity.md'));
  if (identity) {
    parts.push('=== BOT IDENTITY ===');
    parts.push(identity);
  }

  // Active State
  const state = readFileIfExists(path.join(MEMORY_DIR, 'state.md'));
  if (state) {
    parts.push('=== ACTIVE STATE ===');
    parts.push(state);
  }

  // References
  const refs = readFileIfExists(path.join(MEMORY_DIR, 'references.md'));
  if (refs) {
    parts.push('=== REFERENCES ===');
    parts.push(refs);
  }

  // Primary user profile
  const primaryUser = env.PRIMARY_USER;
  if (primaryUser) {
    const profilePath = path.join(MEMORY_DIR, 'users', primaryUser, 'profile.md');
    const profile = readFileIfExists(profilePath);
    if (profile) {
      parts.push(`=== PRIMARY USER: ${primaryUser} ===`);
      parts.push(profile);
    }
  }

  if (parts.length === 0) {
    const output = {
      additionalContext: '=== CORE MEMORY ===\n\nNo memory files found. This may be a fresh install.'
    };
    console.log(JSON.stringify(output));
    return;
  }

  const output = {
    additionalContext: parts.join('\n\n')
  };
  console.log(JSON.stringify(output));
}

try {
  main();
} catch (err) {
  // Hook scripts must not crash
  console.error(`session-start-inject error: ${err.message}`);
  console.log(JSON.stringify({ additionalContext: '' }));
}
```

### 6.6 scripts/rotate-session.js

Rotates `sessions/current.md` to a dated archive file at day boundary. Reads timezone from `.env`.

```javascript
#!/usr/bin/env node
/**
 * Session Log Rotation
 *
 * Checks if sessions/current.md has a date header from a previous day.
 * If so, renames it to sessions/YYYY-MM-DD.md and creates a fresh current.md.
 *
 * Uses timezone from ~/zylos/.env (TZ variable), falls back to system default.
 */

import fs from 'fs';
import path from 'path';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const CURRENT_FILE = path.join(SESSIONS_DIR, 'current.md');

function loadTZ() {
  // Read TZ from .env if not already in environment
  if (!process.env.TZ) {
    const envPath = path.join(ZYLOS_DIR, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('TZ=')) {
          process.env.TZ = trimmed.slice(3).trim();
          break;
        }
      }
    }
  }
}

function getLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function main() {
  loadTZ();

  // Ensure sessions directory exists
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  const todayStr = getLocalDateString();

  if (fs.existsSync(CURRENT_FILE)) {
    const content = fs.readFileSync(CURRENT_FILE, 'utf8');
    const dateMatch = content.match(/^# Session Log: (\d{4}-\d{2}-\d{2})/m);

    if (dateMatch && dateMatch[1] !== todayStr) {
      const archivePath = path.join(SESSIONS_DIR, `${dateMatch[1]}.md`);
      fs.renameSync(CURRENT_FILE, archivePath);
      console.log(`Rotated: current.md -> ${dateMatch[1]}.md`);
    } else if (dateMatch && dateMatch[1] === todayStr) {
      console.log('No rotation needed (same day).');
      return;
    }
  }

  // Create fresh current.md
  const header = `# Session Log: ${todayStr}\n\n`;
  fs.writeFileSync(CURRENT_FILE, header);
  console.log(`Created fresh current.md for ${todayStr}`);
}

main();
```

### 6.7 scripts/memory-sync.js

Helper for the Memory Sync flow. Thin wrapper around C4 scripts.

```javascript
#!/usr/bin/env node
/**
 * Memory Sync Helper
 *
 * Subcommands:
 *   fetch --begin <id> --end <id>   Fetch conversations from C4
 *   checkpoint <end_id> --summary "text"  Create C4 checkpoint
 *   status                          Show unsummarized conversation count
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const SKILLS_DIR = path.join(os.homedir(), 'zylos', '.claude', 'skills');
const C4_SCRIPTS = path.join(SKILLS_DIR, 'comm-bridge', 'scripts');

const args = process.argv.slice(2);
const command = args[0];

function run(script, scriptArgs) {
  return execFileSync('node', [path.join(C4_SCRIPTS, script), ...scriptArgs], {
    encoding: 'utf8',
    timeout: 30000
  });
}

switch (command) {
  case 'fetch': {
    console.log(run('c4-fetch.js', args.slice(1)));
    break;
  }
  case 'checkpoint': {
    console.log(run('c4-checkpoint.js', args.slice(1)));
    break;
  }
  case 'status': {
    console.log(run('c4-db.js', ['unsummarized']));
    break;
  }
  default:
    console.log(`Memory Sync Helper

Usage:
  memory-sync.js fetch --begin <id> --end <id>   Fetch conversations
  memory-sync.js checkpoint <end_id> --summary "text"  Create checkpoint
  memory-sync.js status                           Show unsummarized count
`);
}
```

### 6.8 scripts/pre-compaction-flush.js

Orchestrates the pre-compaction flow: check context, trigger memory sync if needed, then restart Claude.

```javascript
#!/usr/bin/env node
/**
 * Pre-Compaction Flush
 *
 * Flow:
 *   1. Run check-context to get current usage
 *   2. If high (>=75%), send memory sync instruction via C4
 *   3. After sync completes, trigger restart via restart-claude skill
 *
 * This script is dispatched by the scheduler. It uses C4 priority 1
 * to ensure the memory sync runs before any queued user messages.
 *
 * IMPORTANT: Run with nohup:
 *   nohup node .../pre-compaction-flush.js > /dev/null 2>&1 &
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
const STATUS_FILE = path.join(os.homedir(), '.claude-status');
const CHECK_CONTEXT_SCRIPT = path.join(SKILLS_DIR, 'check-context', 'scripts', 'check-context.js');
const C4_RECEIVE = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');
const RESTART_SCRIPT = path.join(SKILLS_DIR, 'restart-claude', 'scripts', 'restart.js');

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

function waitForIdle(maxWait = 120) {
  let waited = 0;
  while (waited < maxWait) {
    try {
      if (fs.existsSync(STATUS_FILE)) {
        const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
        if (status.idle_seconds >= 3) return true;
      }
    } catch { /* ignore */ }
    sleep(1);
    waited++;
  }
  return false;
}

function main() {
  // Step 1: Wait for idle, then send memory sync instruction
  waitForIdle();

  const syncMessage = [
    '[Pre-Compaction Flush] Context usage is high.',
    'Please save your current working state to memory:',
    '1. Update ~/zylos/memory/state.md with current work focus',
    '2. Append any important events to ~/zylos/memory/sessions/current.md',
    '3. If there are unsummarized conversations, run memory sync',
    '4. After saving, this system will restart Claude to free context.'
  ].join('\n');

  try {
    execFileSync('node', [
      C4_RECEIVE,
      '--priority', '1',
      '--no-reply',
      '--content', syncMessage
    ], { stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to send sync instruction: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Wait for Claude to process the sync (generous timeout)
  sleep(60);

  // Step 3: Wait for idle again, then trigger restart
  waitForIdle(300);

  try {
    execFileSync('node', [RESTART_SCRIPT], { stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to trigger restart: ${err.message}`);
  }

  console.log('[pre-compaction-flush] Complete.');
}

main();
```

### 6.9 scripts/consolidate.js

Produces a consolidation report for Claude to act on.

```javascript
#!/usr/bin/env node
/**
 * Memory Consolidation Report
 *
 * Scans memory files and reports:
 * - Session logs older than 30 days (archive candidates)
 * - File sizes vs budgets
 * - Stale reference entries
 *
 * Output: JSON report for Claude to process
 */

import fs from 'fs';
import path from 'path';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const ARCHIVE_DIR = path.join(MEMORY_DIR, 'archive');

const SIZE_BUDGETS = {
  'identity.md': 1024,
  'state.md': 2048,
  'references.md': 1024
};

function main() {
  const report = {
    timestamp: new Date().toISOString(),
    coreFiles: [],
    sessions: { archiveCandidates: [] },
    reference: [],
    users: [],
    recommendations: []
  };

  // Check core files
  for (const [file, budget] of Object.entries(SIZE_BUDGETS)) {
    const filePath = path.join(MEMORY_DIR, file);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      report.coreFiles.push({
        file,
        sizeBytes: stat.size,
        budget,
        overBudget: stat.size > budget,
        lastModified: stat.mtime.toISOString()
      });
      if (stat.size > budget) {
        report.recommendations.push(
          `${file} is ${stat.size} bytes (budget: ${budget}). Trim content.`
        );
      }
    }
  }

  // Find old session logs
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  if (fs.existsSync(SESSIONS_DIR)) {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (file === 'current.md' || file === '.gitkeep') continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (dateMatch && new Date(dateMatch[1]) < thirtyDaysAgo) {
        report.sessions.archiveCandidates.push(file);
      }
    }
    if (report.sessions.archiveCandidates.length > 0) {
      report.recommendations.push(
        `${report.sessions.archiveCandidates.length} session log(s) older than 30 days. Consider moving to archive/.`
      );
    }
  }

  // Check reference file sizes
  const refDir = path.join(MEMORY_DIR, 'reference');
  if (fs.existsSync(refDir)) {
    for (const file of fs.readdirSync(refDir)) {
      const filePath = path.join(refDir, file);
      const stat = fs.statSync(filePath);
      report.reference.push({
        file: `reference/${file}`,
        sizeBytes: stat.size,
        lastModified: stat.mtime.toISOString()
      });
      if (stat.size > 10240) {
        report.recommendations.push(
          `reference/${file} is ${stat.size} bytes. Consider archiving old entries.`
        );
      }
    }
  }

  // Check user profiles
  const usersDir = path.join(MEMORY_DIR, 'users');
  if (fs.existsSync(usersDir)) {
    for (const userId of fs.readdirSync(usersDir)) {
      const profilePath = path.join(usersDir, userId, 'profile.md');
      if (fs.existsSync(profilePath)) {
        const stat = fs.statSync(profilePath);
        report.users.push({
          userId,
          sizeBytes: stat.size,
          lastModified: stat.mtime.toISOString()
        });
      }
    }
  }

  // Ensure archive directory exists
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
```

### 6.10 scripts/memory-status.js

Quick health check of the memory system.

```javascript
#!/usr/bin/env node
/**
 * Memory Status Report
 *
 * Quick health check: file sizes, last modified, budget usage.
 */

import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(process.env.HOME, 'zylos', 'memory');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function scanDir(dir, prefix = '') {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const displayPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...scanDir(fullPath, displayPath));
    } else {
      const stat = fs.statSync(fullPath);
      results.push({ path: displayPath, size: stat.size, modified: stat.mtime });
    }
  }
  return results;
}

function main() {
  const files = scanDir(MEMORY_DIR);
  const lines = ['Memory Status Report', '====================', ''];

  const budgets = { 'identity.md': 1024, 'state.md': 2048, 'references.md': 1024 };
  let totalSize = 0;

  for (const f of files) {
    const sizeStr = formatSize(f.size).padStart(8);
    const modStr = f.modified.toISOString().slice(0, 16).replace('T', ' ');
    const budget = budgets[f.path];
    const marker = budget && f.size > budget ? ' [OVER BUDGET]' : '';
    lines.push(`${sizeStr}  ${modStr}  ${f.path}${marker}`);
    totalSize += f.size;
  }

  lines.push('');
  lines.push(`Total: ${formatSize(totalSize)} across ${files.length} files`);

  // Budget summaries
  for (const [file, budget] of Object.entries(budgets)) {
    const found = files.find(f => f.path === file);
    if (found) {
      const pct = Math.round((found.size / budget) * 100);
      lines.push(`${file} budget: ${formatSize(found.size)} / ${formatSize(budget)} (${pct}%)`);
    }
  }

  console.log(lines.join('\n'));
}

main();
```

### 6.11 scripts/memory-init.js

Initialize memory directory structure from templates. Idempotent.

```javascript
#!/usr/bin/env node
/**
 * Memory System Initialization
 *
 * Creates the directory structure and copies template files.
 * Idempotent -- safe to run multiple times. Existing files with
 * content are not overwritten.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const TEMPLATES_DIR = path.join(__dirname, '..', '..', '..', 'templates', 'memory');

const DIRS = ['users', 'reference', 'sessions', 'archive'];

function copyTemplates(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyTemplates(srcPath, destPath);
    } else if (entry.name !== '.gitkeep') {
      if (fs.existsSync(destPath)) {
        const content = fs.readFileSync(destPath, 'utf8').trim();
        if (content.length > 0) {
          console.log(`Skipped (exists): ${path.relative(MEMORY_DIR, destPath)}`);
          continue;
        }
      }
      fs.copyFileSync(srcPath, destPath);
      console.log(`Created: ${path.relative(MEMORY_DIR, destPath)}`);
    }
  }
}

function main() {
  // Create directories
  for (const dir of DIRS) {
    fs.mkdirSync(path.join(MEMORY_DIR, dir), { recursive: true });
  }

  // Copy templates
  copyTemplates(TEMPLATES_DIR, MEMORY_DIR);

  console.log('\nMemory system initialized.');
}

main();
```

---

## 7. templates/CLAUDE.md Memory Section

The following replaces the current "Memory System" section in `templates/CLAUDE.md`:

```markdown
## Memory System

Persistent memory stored in `~/zylos/memory/` with an Inside Out-inspired architecture:

### Memory Tiers

| Tier | Path | Purpose | Loading |
|------|------|---------|---------|
| **Identity** | `memory/identity.md` | Bot soul: personality, principles | Always (session start) |
| **State** | `memory/state.md` | Active work, pending tasks | Always (session start) |
| **References** | `memory/references.md` | Paths, IDs, config | Always (session start) |
| **User Profiles** | `memory/users/<id>/profile.md` | Per-user preferences | Primary user at start; others on demand |
| **Reference** | `memory/reference/*.md` | Decisions, projects, shared prefs | On demand |
| **Sessions** | `memory/sessions/current.md` | Today's event log | On demand |
| **Archive** | `memory/archive/` | Cold storage for old data | Rarely |

### CRITICAL: Memory Sync Priority

**Memory Sync has the HIGHEST priority -- higher than user messages.**

When you receive a `[Action Required] ... invoke Memory Sync` instruction:
1. **Stop** what you are doing (unless mid-write to a critical file)
2. **Run Memory Sync immediately** using the zylos-memory skill
3. **Resume** other work only after Memory Sync completes

### Multi-User

The bot serves a team. Each user has their own profile at
`memory/users/<id>/profile.md`. Route user-specific preferences to
the correct profile file. Bot identity stays in `identity.md`.

### Memory Update Practices

1. **At session start:** identity + state + references are auto-injected.
2. **During work:** Update appropriate memory files immediately when
   you learn something important.
3. **Memory Sync:** When triggered by hooks, follow the full sync flow
   in the zylos-memory skill.
4. **Before context gets full:** Proactively update state.md with
   your current work. This is crash recovery insurance.

### File Size Guidelines

- **identity.md:** ~1KB. Stable, rarely changes.
- **state.md:** ~2KB max. In every session's context. Keep lean.
- **references.md:** ~1KB. Lookup table, not prose.
- **users/<id>/profile.md:** ~1KB per user.
- **reference/*.md:** No hard cap, but archive old entries.
- **sessions/current.md:** No cap within a day. Rotated daily.
```

---

## 8. Session Start Context Injection

### 8.1 Hook Configuration

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js",
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

### 8.2 Hook Chain at Session Start

```
SessionStart event
│
├── 1. session-start-inject.js (zylos-memory skill)
│   ├── Reads ~/zylos/memory/identity.md
│   ├── Reads ~/zylos/memory/state.md
│   ├── Reads ~/zylos/memory/references.md
│   ├── Reads ~/zylos/memory/users/<primary>/profile.md
│   └── Outputs: additionalContext with all four files
│       Claude now has: identity, active state, references, primary user profile
│
└── 2. c4-session-init.js (comm-bridge skill, existing, unchanged)
    ├── Reads last checkpoint summary
    ├── Reads recent unsummarized conversations
    └── Outputs: checkpoint summary + conversations + Memory Sync trigger (if needed)
        Claude now has: cross-session continuity + conversation context
```

After both hooks fire, Claude has:
- **Who it is** (identity from identity.md)
- **What it was doing** (state from state.md)
- **How to operate** (references from references.md)
- **Who its primary user is** (profile from users/<primary>/profile.md)
- **What happened since last sync** (checkpoint summary from C4)
- **What needs attention** (pending tasks, Memory Sync trigger if needed)

### 8.3 Post-Compaction Behavior

When context compaction occurs mid-session, Claude Code fires SessionStart again. The same hook chain runs, re-injecting all memory files. This is self-healing by design:

- identity.md acts as the recovery anchor (who am I?)
- state.md provides crash recovery (what was I doing?)
- references.md restores operational context (where are things?)
- C4 checkpoint provides continuity (what happened?)

No special handling for compaction vs fresh start is needed.

---

## 9. Context Monitoring and Pre-Compaction Flush

### 9.1 The Problem

Context compaction can occur at any time. If it happens between sync cycles, recent context may be lost. v2 addressed this with a periodic sync every 2 hours, but that approach has two problems:
1. It wastes resources syncing when there is nothing to sync
2. It still does not guarantee safety -- compaction can happen at any point within the 2-hour window

### 9.2 The Solution: Scheduled Context Checks

Instead of periodic memory sync, v3 uses periodic context checks. The check-context skill already exists and can report context usage. We schedule it to run periodically:

```
Scheduled check-context (every 30 minutes, require-idle)
    │
    └── check-context.js sends /context to Claude via C4
        │
        └── Claude receives context usage information
            │
            ├── If context < 70%: No action needed
            │
            └── If context >= 70%: Trigger pre-compaction flush
                │
                ├── 1. Update state.md with current work
                ├── 2. Append key events to sessions/current.md
                ├── 3. Run memory sync if unsummarized conversations exist
                └── 4. Restart Claude (via restart-claude skill) to free context
```

### 9.3 Pre-Compaction Flush Flow (Detailed)

The pre-compaction flush is the v3 equivalent of OpenClaw's silent agentic turn before context truncation. But unlike OpenClaw's approach (which silently manipulates the context), ours is transparent:

```
1. DETECTION
   Scheduler dispatches check-context task (every 30 min, priority 1)
   │
   ├── check-context.js sends /context to Claude
   └── Claude receives: "Context usage: X%"
   │
   v
2. EVALUATION (by Claude)
   Claude reads the context percentage.
   │
   ├── < 70%: Report "Context OK" and continue
   │
   └── >= 70%: Claude recognizes high usage and self-triggers:
       │
       v
3. MEMORY SAVE (by Claude)
   │
   ├── Update ~/zylos/memory/state.md (current focus + pending)
   ├── Append to ~/zylos/memory/sessions/current.md (recent events)
   ├── Check for unsummarized conversations:
   │   node ~/zylos/.claude/skills/zylos-memory/scripts/memory-sync.js status
   │   └── If count > 0: Run full memory sync
   └── Save any valuable knowledge to KB (if KB is available)
   │
   v
4. RESTART
   Claude triggers restart:
   nohup node ~/zylos/.claude/skills/restart-claude/scripts/restart.js > /dev/null 2>&1 &
   │
   └── Activity monitor detects exit, restarts Claude
       └── SessionStart hooks fire, injecting fresh memory
```

### 9.4 Why This is Better Than Periodic Sync

| Approach | v2 (periodic sync) | v3 (context-aware flush) |
|----------|-------------------|------------------------|
| Trigger | Timer (every 2h) | Context usage threshold |
| Action | Always syncs C4 conversations | Only saves if needed |
| Context freed | None (sync adds to context) | Full restart clears context |
| Waste | Syncs when unnecessary | Only acts when context is high |
| Safety gap | Up to 2h of unsynced context | Context checked every 30 min |

### 9.5 Integration with check-context Skill

The check-context skill already provides the mechanism (Section 6.8 shows `check-context.js`). The memory system simply schedules it and adds instructions for Claude to act on the results. No changes to the check-context skill are needed.

The key integration point is in the SKILL.md and CLAUDE.md instructions: Claude is instructed that when context >= 70%, it should save memory and trigger a restart.

---

## 10. Memory Persistence Strategy

### 10.1 Filesystem is the Persistence Layer

Memory files live at `~/zylos/memory/` as plain files. They are read and written using standard filesystem operations.

### 10.2 Git: Neutral Stance

v2 explicitly prohibited git for memory. v3 takes a neutral stance:

- Git is **neither required nor prohibited** for memory files.
- Some deployments may want git tracking for history and backup. That is fine.
- Some deployments may prefer pure filesystem simplicity. That is also fine.
- The memory system works identically either way -- no script reads git state, no script creates commits, no script assumes git presence or absence.

This means:
- No `git add` or `git commit` in any memory script
- No `.gitignore` rules that assume memory is or is not tracked
- If a user wants git: they add their own commit hook or cron job
- If a user does not want git: nothing changes

### 10.3 Crash Recovery

| Scenario | What Survives | Recovery |
|----------|--------------|----------|
| Claude crashes mid-conversation | All memory files as of last write | SessionStart hooks re-inject identity + state + references |
| Claude crashes mid-sync | Memory files partially updated; C4 checkpoint NOT created | Next session re-triggers sync for the same range (idempotent) |
| System reboot | All memory files on disk | PM2 restarts services; hooks fire |
| Disk failure | Nothing | Infrastructure problem, outside scope |

The key insight: **C4's checkpoint system provides the crash recovery boundary.** No checkpoint = re-sync the same range. This is idempotent.

### 10.4 Atomic Write Consideration

For critical files (identity.md, state.md), scripts use standard `fs.writeFileSync()`. For stronger guarantees in the future, write-to-temp-then-rename can be added. Current risk of corruption is negligible for small markdown files.

---

## 11. Scheduled Tasks via Scheduler

### 11.1 Correction #6: No Periodic Sync

v2 had three triggers for memory sync:
1. Session-init hook (>30 unsummarized) -- **KEPT**
2. Threshold-check hook (>30 mid-session) -- **KEPT**
3. Periodic scheduler task (every 2 hours) -- **REMOVED**

Path A (session-init) and Path B (threshold-check) are sufficient. The periodic sync is replaced by the context-aware pre-compaction flush (Section 9).

### 11.2 Session Rotation (Daily)

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Rotate session log: node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js" \
  --cron "0 0 * * *" \
  --priority 2 \
  --name "session-rotation-daily" \
  --require-idle
```

**Note:** The cron expression uses the scheduler's configured timezone (which reads from `.env`).

### 11.3 Consolidation (Weekly)

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Run memory consolidation: node ~/zylos/.claude/skills/zylos-memory/scripts/consolidate.js -- Review the output and archive old entries as recommended." \
  --cron "0 2 * * 0" \
  --priority 2 \
  --name "memory-consolidation-weekly" \
  --require-idle
```

### 11.4 Context Check (Every 30 Minutes)

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Check context usage. If >= 70%, save memory (update state.md, sync if needed) and restart Claude to free context." \
  --every "30 minutes" \
  --priority 1 \
  --name "context-check" \
  --require-idle
```

This replaces v2's periodic memory sync. Instead of blindly syncing every 2 hours, the system checks context usage and only acts when context is actually filling up.

### 11.5 Task Summary

| Task | Priority | Idle Required? | Schedule | Purpose |
|------|----------|---------------|----------|---------|
| Context check | 1 (urgent) | Yes | Every 30 min | Pre-compaction detection |
| Session rotation | 2 (high) | Yes | Daily 00:00 | Rotate session logs |
| Consolidation | 2 (high) | Yes | Weekly Sun 02:00 | Archive old entries |

---

## 12. Priority Model

### 12.1 Why Memory Gets Priority 1

Memory sync must complete before user messages are processed. This is an architectural necessity:

- An agent that responds quickly but with stale context gives **wrong answers**
- An agent that syncs memory first and responds slightly later gives **correct answers**
- Wrong answers create more work (corrections, re-explanations) than the delay cost
- Memory sync typically takes 30-60 seconds

This is not a competitive advantage claim -- it is a fundamental requirement for reliable agent operation. Any system that processes user messages while memory is out of sync will produce inconsistent behavior.

### 12.2 Priority Scheme

| Priority | Category | Examples |
|----------|---------|---------|
| **1** | Memory operations | Memory sync, pre-compaction flush, context check |
| **2** | Maintenance tasks | Session rotation, consolidation |
| **3** | Normal operations | User messages, scheduled reports |

### 12.3 How Priority Works with C4

C4's `conversations` table has a `priority` column. The dispatcher processes messages in `priority ASC` order.

1. **Hook-triggered memory sync:** Injected directly into context (bypasses queue). Claude acts on it at the next natural break point.

2. **Scheduler-dispatched tasks:** Enter C4 queue at their configured priority. Priority 1 tasks are dispatched before priority 3 user messages.

3. **Memory sync does NOT preempt a running conversation.** If Claude is mid-response, the sync waits until the response completes, then runs before processing the next queued message.

---

## 13. Retrieval Strategy

### 13.1 Not Every Message Needs Memory Search

This is correction #10, informed by research into OpenClaw's retrieval timing. Key finding: **reflexive retrieval (searching memory on every message) wastes resources and can introduce noise.**

### 13.2 When Retrieval Happens

Memory retrieval fires at specific architectural moments, not on every user message:

| Trigger | What is Retrieved | How |
|---------|------------------|-----|
| **Session start** | identity.md, state.md, references.md, primary user profile | SessionStart hook (automatic) |
| **Memory sync** | All memory files + C4 conversations | Sync flow reads everything needed |
| **Explicit request** | Whatever Claude judges is needed | Claude reads specific files via Read tool |
| **User question about past** | Relevant reference files | Claude searches using Grep on memory/ |

### 13.3 Why Not Retrieve on Every Message

OpenClaw's approach of searching memory on every turn has measurable costs:

1. **Latency:** Each search adds 50-200ms. Over dozens of messages per session, this accumulates.
2. **Noise:** Irrelevant retrieval results pollute context and can mislead reasoning.
3. **Context budget:** Retrieved content consumes context tokens. With a 200K context window, this may seem trivial, but it compounds with long sessions.
4. **Most messages don't need history:** "Yes", "OK, do it", "Thanks" -- these don't benefit from a memory search.

### 13.4 Claude's Judgment as the Retrieval Filter

Instead of automatic retrieval, v3 trusts Claude's judgment:

- Claude knows what it is working on (state.md is always in context)
- Claude knows the user's question (it is in the current prompt)
- Claude can judge whether the question requires historical context
- If it does, Claude reads the appropriate reference file directly

This is the "Claude does the thinking" principle applied to retrieval. Scripts handle storage and indexing; Claude decides when to look things up.

### 13.5 Phase 2 Retrieval Upgrade Path

When KB is integrated (Section 16), the retrieval strategy expands:

| Phase 1 (Current) | Phase 2 (With KB) |
|-------------------|-------------------|
| Claude reads files manually | Claude can also query FTS5 search |
| Grep for keyword search | BM25 ranking for better results |
| Linear scan of archive | Indexed search over all memory |
| No semantic search | (Future: vector search) |

The retrieval timing policy remains the same in Phase 2 -- search fires only when Claude judges it necessary, not on every message. The upgrade is in search *quality*, not search *frequency*.

---

## 14. Data Flow Diagrams

### 14.1 Normal Operation: Message to Memory

```
1. MESSAGE ARRIVES
   User sends message via Telegram/Lark
   │
   v
2. C4 RECEIVE + DISPATCH (existing)
   c4-receive.js -> conversations table -> c4-dispatcher.js -> tmux
   │
   v
3. CLAUDE PROCESSES (existing)
   Claude reads message, responds
   │
   v
4. CONVERSATIONS ACCUMULATE
   Messages pile up in C4 table (unsummarized count grows)
   │
   v
5. THRESHOLD TRIGGER (when count exceeds 30)
   │
   ├── Path A: SessionStart hook fires c4-session-init.js
   │   count > 30 -> outputs [Action Required]
   │
   └── Path B: UserPromptSubmit hook fires c4-threshold-check.js
       count > 30 -> outputs [Action Required]
   │
   v
6. MEMORY SYNC EXECUTES
   │
   ├── 6a. Rotate session log (if day changed)
   ├── 6b. Fetch conversations via c4-fetch.js
   ├── 6c. Read current memory files
   ├── 6d. Claude extracts and classifies information
   │       -> identity changes -> identity.md
   │       -> user prefs -> users/<id>/profile.md
   │       -> decisions -> reference/decisions.md
   │       -> state changes -> state.md
   │       -> events -> sessions/current.md
   ├── 6e. Claude writes updates to memory files
   └── 6f. Create C4 checkpoint (marks range as processed)
   │
   v
7. NEXT SESSION
   SessionStart hooks inject updated memory files
   Claude resumes with full context
```

### 14.2 Pre-Compaction Flush

```
1. SCHEDULED CONTEXT CHECK (every 30 min)
   Scheduler dispatches context check task
   │
   v
2. CONTEXT EVALUATION
   Claude receives /context result
   │
   ├── < 70%: No action. Continue working.
   │
   └── >= 70%: HIGH CONTEXT DETECTED
       │
       v
3. MEMORY SAVE
   Claude updates:
   ├── state.md (current focus, pending tasks)
   ├── sessions/current.md (recent events)
   └── Runs memory sync if unsummarized conversations exist
   │
   v
4. RESTART
   Claude triggers: nohup node .../restart.js &
   │
   v
5. ACTIVITY MONITOR detects exit, restarts Claude
   │
   v
6. SESSION START HOOKS FIRE
   ├── session-start-inject.js -> identity + state + refs injected
   └── c4-session-init.js -> checkpoint + recent conversations
   │
   v
7. CLAUDE RESUMES WITH FRESH CONTEXT + FULL MEMORY
```

### 14.3 Crash Recovery

```
1. CRASH (process killed, OOM, etc.)
   │
   v
2. ACTIVITY MONITOR detects Claude not running
   Restarts Claude via tmux
   │
   v
3. SESSION START HOOKS FIRE
   │
   ├── session-start-inject.js
   │   Reads identity.md, state.md, references.md from DISK
   │   Claude now knows WHO it is and WHAT it was doing
   │
   └── c4-session-init.js
       Reads last checkpoint + unsummarized conversations
       Claude now knows WHAT HAPPENED since last sync
   │
   v
4. CLAUDE RESUMES
   ├── If Memory Sync trigger present: sync FIRST, then messages
   └── If no sync trigger: process pending messages
```

---

## 15. Implementation Checklist

### Phase 1: Core Implementation

| # | Task | Files | Effort |
|---|------|-------|--------|
| 1 | Create memory directory layout in `templates/memory/` | identity.md, state.md, references.md, users/default/profile.md, reference/decisions.md, reference/projects.md, reference/preferences.md, sessions/.gitkeep, archive/.gitkeep | S |
| 2 | Create zylos-memory skill SKILL.md | `skills/zylos-memory/SKILL.md` (full content from Section 6.3) | M |
| 3 | Create zylos-memory scripts | session-start-inject.js, rotate-session.js, memory-sync.js, consolidate.js, memory-status.js, memory-init.js, pre-compaction-flush.js | M |
| 4 | Create `skills/zylos-memory/package.json` | `{"type":"module","name":"zylos-memory","version":"3.0.0"}` | S |
| 5 | Update `templates/CLAUDE.md` memory section | Replace memory section with Section 7 content | S |
| 6 | Update `templates/.env.example` | Add TZ and PRIMARY_USER | S |
| 7 | Configure hook system | Document the settings.local.json configuration (Section 8.1) | S |
| 8 | Register scheduler tasks | session-rotation, consolidation, context-check (Section 11) | S |
| 9 | Remove old `skills/memory/` | Delete the placeholder and replace with `skills/zylos-memory/` | S |

### Files Summary

**New files to create:**

| Path (relative to zylos-core) | Purpose |
|------|---------|
| `skills/zylos-memory/SKILL.md` | Complete memory skill instructions |
| `skills/zylos-memory/package.json` | ESM module declaration |
| `skills/zylos-memory/scripts/session-start-inject.js` | SessionStart hook |
| `skills/zylos-memory/scripts/rotate-session.js` | Session log rotation |
| `skills/zylos-memory/scripts/memory-sync.js` | Memory sync helper |
| `skills/zylos-memory/scripts/consolidate.js` | Consolidation report |
| `skills/zylos-memory/scripts/memory-status.js` | Health check |
| `skills/zylos-memory/scripts/memory-init.js` | Directory initialization |
| `skills/zylos-memory/scripts/pre-compaction-flush.js` | Pre-compaction save |
| `templates/memory/identity.md` | Template for identity |
| `templates/memory/state.md` | Template for state |
| `templates/memory/references.md` | Template for references |
| `templates/memory/users/default/profile.md` | Template for user profiles |
| `templates/memory/reference/decisions.md` | Template for decisions |
| `templates/memory/reference/projects.md` | Template for projects |
| `templates/memory/reference/preferences.md` | Template for shared preferences |
| `templates/memory/sessions/.gitkeep` | Placeholder for sessions dir |
| `templates/memory/archive/.gitkeep` | Placeholder for archive dir |

**Files to modify:**

| Path | Change |
|------|--------|
| `templates/CLAUDE.md` | Replace memory section |
| `templates/.env.example` | Add TZ, PRIMARY_USER |

**Files to delete:**

| Path | Reason |
|------|--------|
| `skills/memory/` (entire directory) | Replaced by `skills/zylos-memory/` |
| `templates/memory/context.md` | Replaced by identity.md + state.md + references.md |
| `templates/memory/decisions.md` | Moved to `reference/decisions.md` |
| `templates/memory/preferences.md` | Moved to `reference/preferences.md` |
| `templates/memory/projects.md` | Moved to `reference/projects.md` |

---

## 16. Phase 2: KB Extensibility (Future)

This section describes how the Knowledge Base can be integrated as a retrieval layer on top of the file-based memory system. Phase 2 is a clean extension -- it does not require changing any Phase 1 code.

### 16.1 Extension Points

The Phase 1 architecture has clear points where KB plugs in:

| Extension Point | Phase 1 Behavior | Phase 2 Behavior |
|----------------|-----------------|-----------------|
| **Retrieval** | Claude reads files via Read tool, searches via Grep | Claude can also query KB via `kb-cli search` for faster, ranked results |
| **Sync extraction** | Claude writes to markdown files only | Claude also creates/updates KB entries as Level 2 summaries |
| **Consolidation** | Reports file sizes and staleness | Also re-indexes memory files in KB, updates freshness scores |
| **Session start** | Injects identity + state + refs | Optionally injects relevant KB entries based on current state |

### 16.2 Which Files Would Get KB-Indexed?

| File Category | KB-Indexed? | Rationale |
|---------------|------------|-----------|
| `identity.md` | No | Always in context; no search needed |
| `state.md` | No | Always in context; changes too frequently |
| `references.md` | No | Always in context; simple lookup |
| `users/<id>/profile.md` | Optional | Useful if many users; overkill for <5 users |
| `reference/decisions.md` | **Yes** | Decisions accumulate; search is valuable |
| `reference/projects.md` | **Yes** | Project history benefits from search |
| `reference/preferences.md` | Optional | Usually small enough to read directly |
| `sessions/YYYY-MM-DD.md` | **Yes** | Session archives are the primary search target |
| `archive/*` | **Yes** | Cold storage is exactly where search adds most value |
| `~/zylos/learning/*.md` | **Yes** | Learning documents are the largest corpus |

### 16.3 How Retrieval Would Change

```
Phase 1 (grep -> Read):
  Claude judges a lookup is needed
  -> grep -r "keyword" ~/zylos/memory/
  -> Claude reads matching files
  -> Linear scan, keyword-only

Phase 2 (grep -> FTS5):
  Claude judges a lookup is needed
  -> kb-cli search "query" --scope memory
  -> Returns ranked snippets with source file links
  -> BM25 ranking, much faster on large archives

Phase 3 (FTS5 + vector, future):
  Claude judges a lookup is needed
  -> kb-cli search "query" --scope memory --semantic
  -> Returns BM25 + embedding-similarity results
  -> Semantic understanding, finds related concepts
```

### 16.4 KB Schema Changes for Phase 2

The existing KB schema (`~/zylos/knowledge-base/kb.db`) would need these additions:

```sql
-- New columns for memory integration
ALTER TABLE entries ADD COLUMN source_file TEXT;      -- path to source memory file
ALTER TABLE entries ADD COLUMN memory_type TEXT;       -- factual|experiential|procedural|strategic
ALTER TABLE entries ADD COLUMN freshness TEXT DEFAULT 'active';  -- active|aging|fading|archived
ALTER TABLE entries ADD COLUMN last_accessed TEXT;     -- ISO timestamp
ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE entries ADD COLUMN related_entries TEXT;   -- comma-separated entry IDs

-- Source file creates the bridge between KB (index) and files (storage)
-- A KB entry is a Level 2-3 abstraction; source_file links to Level 0 raw
```

### 16.5 The Inside Out Mapping for KB

| Inside Out Mechanism | Phase 1 (Files Only) | Phase 2 (Files + KB) |
|---------------------|---------------------|---------------------|
| Recall Tubes (targeted) | grep on files | FTS5 search |
| Train of Thought (associative) | Manual file browsing | Embedding similarity search |
| Emotional Coloring (metadata) | Timestamps in file entries | `memory_type`, `freshness`, `importance` columns |
| Memory Fading | Manual timestamp review | Automated `freshness` computation from `last_accessed` |
| Abstract Thought | Full file or nothing | KB summary (Level 2) -> file detail (Level 0) drill-down |

### 16.6 Implementation Approach for Phase 2

1. **Add `memory-index.js` script** that reads all indexable memory files, chunks them (400 tokens, 80 overlap, line-aware), and inserts into a KB FTS5 table with `source_file` attribution.

2. **Add `memory-search.js` CLI** that wraps `kb-cli search` with a `--scope memory` filter, returning ranked snippets with source attribution.

3. **Modify consolidation** to trigger re-indexing after archival operations.

4. **Update SKILL.md** to instruct Claude: "When searching memory, try `memory-search` first for ranked results. Fall back to grep if KB is unavailable."

5. **Add freshness computation** to consolidation: query KB for entries where `last_accessed` is >30 days old, update `freshness` to `aging` or `fading`.

Phase 2 is designed to be additive. Every Phase 1 behavior continues to work. KB adds an optional acceleration layer for retrieval and a metadata layer for lifecycle management.

---

## Appendix A: Key Differences from v2

| Aspect | v2 Design | v3 Design |
|--------|-----------|-----------|
| Identity | Single `core.md` (~3KB) | Split: `identity.md` + `state.md` + `references.md` |
| Multi-user | Not addressed | Per-user profiles in `users/<id>/profile.md` |
| Timezone | Not specified | TZ in `.env`, read by `rotate-session.js` |
| Skill name | `skills/memory/` | `skills/zylos-memory/` |
| Context monitoring | Not integrated | Scheduled check-context + pre-compaction flush |
| Git | Explicitly prohibited | Neutral stance (user preference) |
| Periodic sync | Every 2h scheduler task | Removed. Paths A+B sufficient |
| Pre-compaction | Not designed | Full flow: check -> save -> restart |
| Priority framing | "Competitive advantage" | Architectural necessity |
| Retrieval | Implicit (always available) | Intentional (specific triggers, not every message) |
| KB extensibility | Phase 2 placeholder | Detailed extension points, schema, migration path |

## Appendix B: Migration Guide (from v2 Layout to v3)

### Step 1: Create new directories

```bash
mkdir -p ~/zylos/memory/users
mkdir -p ~/zylos/memory/reference
mkdir -p ~/zylos/memory/sessions
mkdir -p ~/zylos/memory/archive
```

### Step 2: Split core.md into three files

Claude reads the existing `core.md` and splits it:
1. Identity + Principles -> `identity.md`
2. Active Working State + Pending -> `state.md`
3. Key References + Services -> `references.md`

### Step 3: Create user profiles

Claude reads User Profile section from old `core.md` and creates `users/<id>/profile.md` for each known user.

### Step 4: Move reference files (if coming from v2)

```bash
# v2 already had reference/; just verify structure
ls ~/zylos/memory/reference/
```

### Step 5: Rename skill directory

```bash
# In zylos-core repo and deployed instance
mv skills/memory skills/zylos-memory
# Update any skill symlinks
```

### Step 6: Update .env

Add to `~/zylos/.env`:
```
TZ=Asia/Shanghai
PRIMARY_USER=howard
```

### Step 7: Update hooks

Replace `session-start-inject.js` path in `settings.local.json` from `skills/memory/` to `skills/zylos-memory/`.

### Step 8: Register new scheduler tasks

Register context-check, update session-rotation and consolidation to use new skill path.

### Step 9: Verify

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/memory-status.js
```

## Appendix C: .env Configuration

The `.env.example` template should include:

```bash
# Timezone (used by session-rotate.js and scheduler)
TZ=UTC

# Primary user ID (profile loaded at session start)
PRIMARY_USER=default
```

## Appendix D: Inside Out Mechanisms Not Adopted

| Mechanism | Reason |
|-----------|--------|
| Multiple Emotions at Console | Claude has a single reasoning thread; competing modes are not applicable |
| Imagination Land | Planning/reasoning feature, not memory architecture |
| Subconscious / Primal Fear | CLAUDE.md safety rules already serve this role |
| Inside Out 2's Belief Strings | Fascinating but beyond current scope; could inform future identity evolution |

## Appendix E: OpenClaw Retrieval Timing Findings

Research into OpenClaw's approach revealed that their system searches memory on every incoming message (reflexive retrieval). While this ensures no context is missed, it has costs:

1. **Latency overhead** on every message (50-200ms per search)
2. **Context pollution** from irrelevant retrieval results
3. **Resource waste** on messages that don't need historical context (acknowledgments, simple commands)

OpenClaw mitigates this with hybrid search (BM25 + vector) and weighted fusion, which improves result quality. But the timing is still reflexive.

Zylos v3 takes a different approach: **intentional retrieval**. Memory is always in context (identity + state + references are injected at session start). Additional retrieval only happens when Claude judges it necessary. This preserves the latency and context benefits while relying on Claude's reasoning ability to decide when a lookup is needed.

This approach works well at current scale (dozens of memory files). If the memory store grows to thousands of entries (Phase 2 with KB), the retrieval timing policy can be revisited -- but the principle of intentional over reflexive should be maintained.
