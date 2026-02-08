# Memory Architecture v2 -- Complete Design

**Date:** 2026-02-07
**Author:** Architecture Design Agent
**Based on:** Howard's 8 corrections to v1 proposal, Inside Out-inspired memory research, C4 capabilities analysis, v1 implementation plan review
**Target:** zylos-core (open-source framework, not Zylos personal setup)

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Memory File Layout](#2-memory-file-layout)
3. [Template Files (templates/memory/)](#3-template-files-templatesmemory)
4. [Memory Skill Design (skills/memory/)](#4-memory-skill-design-skillsmemory)
5. [templates/CLAUDE.md Memory Section](#5-templatesclaude-md-memory-section)
6. [Session Start Context Injection](#6-session-start-context-injection)
7. [Memory Persistence Strategy](#7-memory-persistence-strategy)
8. [Scheduled Tasks via Scheduler](#8-scheduled-tasks-via-scheduler)
9. [Priority Model](#9-priority-model)
10. [Data Flow Diagrams](#10-data-flow-diagrams)
11. [Implementation Checklist](#11-implementation-checklist)

---

## 1. Design Principles

These principles are derived from Howard's 8 corrections and govern every design decision in this document.

### 1.1 Howard's Corrections Applied

| # | Correction | How This Design Responds |
|---|-----------|--------------------------|
| 1 | Memory task priority > user messages | Memory sync runs at priority 1 (urgent). See Section 9. |
| 2 | Base on zylos-core | All paths reference zylos-core structure. Skills in `skills/`, runtime data in `~/zylos/`, templates in `templates/`. |
| 3 | Memory skill is blank slate | Completely new design from scratch. No constraints from current placeholder. |
| 4 | templates/CLAUDE.md is modifiable | Full memory system section designed for templates/CLAUDE.md. See Section 5. |
| 5 | NO git commit for memory | Memory files are plain files on disk. No git add, no git commit, no git tracking of memory. |
| 6 | No post-compact-inject.sh | Uses Claude Code's native hook system (`settings.local.json` hooks) exclusively. |
| 7 | Node.js only | All scripts are Node.js ESM. Zero shell scripts. |
| 8 | Timers through scheduler skill | All periodic tasks registered via C5 scheduler CLI. No setInterval, no cron, no custom timers. |

### 1.2 Core Principles

1. **Memory is higher priority than conversation.** The agent must maintain its own memory health before serving user requests. An agent that loses context is useless regardless of how fast it responds.

2. **Files on disk, not in git.** Memory files are living documents that change frequently. Git adds overhead (staging, committing, conflict resolution) with no benefit for runtime memory. The filesystem is the persistence layer. If the disk survives, memory survives.

3. **Node.js ESM only.** Every script in the memory system is a Node.js ESM module. No bash scripts, no shell wrappers, no CommonJS.

4. **Scheduler is the clock.** Any operation that needs to happen on a schedule (sync, rotation, consolidation) is registered as a scheduler task. The memory skill itself has no timers.

5. **Tiered loading.** Not all memory needs to be in context at all times. Core identity is always loaded. Reference files are loaded on demand. Session logs are append-only and rarely re-read in full.

6. **Claude does the thinking.** The memory sync process relies on Claude's reasoning to extract, classify, and prioritize information from conversations. Scripts handle I/O; Claude handles intelligence.

---

## 2. Memory File Layout

### 2.1 Directory Structure

```
~/zylos/memory/
├── core.md              # Identity + active state (ALWAYS loaded at session start)
├── reference/
│   ├── decisions.md     # Key decisions and their rationale
│   ├── projects.md      # Active, planned, and completed projects
│   └── preferences.md   # User preferences and working style
├── sessions/
│   ├── current.md       # Today's session log (append-only within a day)
│   └── YYYY-MM-DD.md    # Archived daily session logs
└── archive/             # Cold storage for rotated/sunset items
    └── (files moved here by consolidation)
```

### 2.2 File Specifications

#### core.md -- The Identity Anchor

**Purpose:** Contains everything Claude needs to know to resume operation after a crash, compaction, or fresh session start. This is the single most important memory file.

**Always loaded:** Yes, injected at every session start via the SessionStart hook.

**Size guideline:** ~3KB maximum. This file is injected into every session context, so every byte counts. If it grows beyond 3KB, Claude must prune it during the next memory sync.

**Structure:**

```markdown
# Core Memory

Last updated: YYYY-MM-DD HH:MM

## Identity
[Who this agent is, what deployment it serves, what its role is]

## User Profile
[Name, communication preferences, key principles, working style]

## Active Working State
[What is currently being worked on -- the single most important section for crash recovery.
 Updated every memory sync. 2-5 bullet points max.]

## Key References
[Paths, IDs, URLs, service endpoints relevant to current work.
 Only include what's actively needed. Remove stale references during sync.]

## Pending
[Things the user has asked for that haven't been completed yet.
 Critical for not dropping tasks across sessions.]
```

**What belongs here:** Identity information, current work focus, pending tasks, critical references. Information that changes every session.

**What does NOT belong here:** Historical decisions, project archives, detailed preferences, session logs. Those go in reference/ or sessions/.

---

#### reference/decisions.md -- Decision Log

**Purpose:** Records key decisions made by the user or agent, with context and rationale. Decisions constrain future behavior -- knowing *why* something was decided prevents re-litigating it.

**Loaded:** On demand (when Claude needs to check past decisions, or during memory sync).

**Size guideline:** No hard cap, but entries older than 90 days with status `archived` should be moved to `archive/decisions-YYYY.md` during consolidation.

**Entry format:**

```markdown
### [YYYY-MM-DD] Decision Title
- **Decision:** What was decided
- **Context:** Why this came up (1 sentence)
- **Status:** active | superseded | archived
```

---

#### reference/projects.md -- Project Tracker

**Purpose:** Tracks active, planned, and recently completed projects. Provides context for what the agent should be working on.

**Loaded:** On demand.

**Size guideline:** Keep only active and recently completed (last 30 days) projects in this file. Older completed projects move to archive.

**Entry format:**

```markdown
### Project Name
- **Status:** active | completed | blocked | planned
- **Updated:** YYYY-MM-DD
- **Notes:** Current state (2-3 sentences max)
```

---

#### reference/preferences.md -- User Preferences

**Purpose:** Records observed and stated user preferences. This is a living document that grows as the agent learns how the user likes to work.

**Loaded:** On demand (and recommended to read at the start of any user-facing task).

**Size guideline:** No hard cap, but prefer consolidation over accumulation. If two preferences conflict, keep the newer one and mark the older as superseded.

**Entry format:**

```markdown
### Preference Name
- **Value:** The preference
- **Source:** stated | observed
- **Added:** YYYY-MM-DD
```

---

#### sessions/current.md -- Today's Session Log

**Purpose:** Append-only log of significant events during the current day. This is the "working scratchpad" -- it captures what happened without requiring the agent to decide where it belongs yet. During memory sync, information may be promoted from here to reference files or core.md.

**Loaded:** On demand (during memory sync, or when Claude needs to recall what happened today).

**Size guideline:** No cap within a day. At day boundary, the file is rotated to `sessions/YYYY-MM-DD.md` and a fresh `current.md` is created.

**Entry format:**

```markdown
# Session Log: YYYY-MM-DD

**HH:MM** - Brief description of event, completion, decision, or issue
**HH:MM** - Another entry
```

---

#### sessions/YYYY-MM-DD.md -- Archived Daily Logs

**Purpose:** Read-only archives of past session logs. Created by rotating `current.md` at day boundaries. Useful for memory sync when processing conversations that span multiple days.

**Loaded:** Rarely, only when investigating past events.

**Size guideline:** No cap. Old sessions (>30 days) can be moved to `archive/` during consolidation.

---

#### archive/ -- Cold Storage

**Purpose:** Holding area for old session logs, superseded decisions, completed projects. Not actively loaded, but searchable via grep.

**Loaded:** Never automatically. Only when explicitly searching for historical information.

---

### 2.3 Loading Strategy

| File | When Loaded | How |
|------|------------|-----|
| `core.md` | Every session start, every post-compaction | SessionStart hook injects content |
| `reference/*.md` | During memory sync, when Claude needs context | Claude reads via Read tool |
| `sessions/current.md` | During memory sync | Claude reads via Read tool |
| `sessions/YYYY-MM-DD.md` | Rarely, for historical lookup | Claude reads via Read tool |
| `archive/*` | Almost never | Claude uses Grep to search |

---

## 3. Template Files (templates/memory/)

These are the files that ship with zylos-core and get copied to `~/zylos/memory/` during installation. They are the blank-slate starting point for a new deployment.

### 3.1 Directory Structure in Repository

```
templates/memory/
├── core.md
├── reference/
│   ├── decisions.md
│   ├── projects.md
│   └── preferences.md
└── sessions/
    └── .gitkeep
```

Note: `archive/` is not included in templates because it starts empty. The `sessions/` directory includes a `.gitkeep` so git tracks the empty directory. The `sessions/current.md` file is created on first session start by the session rotation script.

### 3.2 Template Contents

#### templates/memory/core.md

```markdown
# Core Memory

Last updated: (not yet)

## Identity
I am a Zylos agent -- an autonomous AI assistant. Ready for first interaction.

## User Profile
- Name: (to be learned)
- Communication: (to be learned)
- Preferences: (to be learned)

## Active Working State
Fresh installation. No active tasks.

## Key References
- Memory: ~/zylos/memory/
- Skills: ~/zylos/.claude/skills/

## Pending
None yet.
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
# User Preferences

Observed and stated preferences. Updated by Memory Sync.

(No preferences recorded yet.)
```

### 3.3 Installation Integration

The `install.sh` script already copies `templates/memory/*` to `~/zylos/memory/`. The new directory structure requires a small update to `install.sh` (or the equivalent Node.js install script) to create the subdirectories:

```javascript
// In the install script, replace the flat memory copy with:
import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(process.env.HOME, 'zylos', 'memory');

// Create subdirectories
for (const sub of ['reference', 'sessions', 'archive']) {
  fs.mkdirSync(path.join(MEMORY_DIR, sub), { recursive: true });
}

// Copy template files (preserving directory structure)
// templates/memory/ -> ~/zylos/memory/
```

The existing line `cp -r "$CORE_DIR/templates/memory/"* "$ZYLOS_DIR/memory/"` will handle this correctly since it copies recursively, as long as the subdirectories exist in the template.

---

## 4. Memory Skill Design (skills/memory/)

This is a complete redesign. The current `skills/memory/SKILL.md` is a placeholder. The new memory skill encompasses the entire memory system: sync, rotation, consolidation, and the instructions Claude follows to maintain memory.

### 4.1 File Structure

```
skills/memory/
├── SKILL.md                    # Complete memory system instructions for Claude
├── package.json                # {"type":"module"}
└── scripts/
    ├── memory-sync.js          # Fetch conversations + helpers for sync flow
    ├── rotate-session.js       # Rotate current.md -> YYYY-MM-DD.md at day boundary
    ├── consolidate.js          # Archive old entries, prune stale data
    └── memory-status.js        # Report memory file sizes and health
```

### 4.2 SKILL.md

```yaml
---
name: memory
description: >-
  Core memory system (C3). Maintains persistent memory across sessions via tiered
  markdown files. Handles Memory Sync (processing C4 conversations into structured
  memory), session rotation, and consolidation. Memory Sync has HIGHEST priority --
  it must complete before any user requests are processed. Invoke /memory when
  triggered by C4 hooks or scheduler, or when memory files need manual maintenance.
argument-hint: [sync --begin <id> --end <id> | rotate | consolidate | status]
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Memory System (C3)

Maintains persistent memory across sessions via tiered markdown files.

## Architecture

```
~/zylos/memory/
├── core.md              # Always loaded at session start (~3KB cap)
├── reference/
│   ├── decisions.md     # Key decisions with rationale
│   ├── projects.md      # Active/planned projects
│   └── preferences.md   # User preferences and style
├── sessions/
│   ├── current.md       # Today's session log
│   └── YYYY-MM-DD.md    # Past session logs
└── archive/             # Cold storage
```

## Memory Sync

### PRIORITY: Memory Sync is the HIGHEST priority task.

When C4 hooks or the scheduler trigger a Memory Sync, you MUST process it
before responding to any pending user messages. Memory integrity is more
important than response speed. An agent without memory context gives wrong
answers; a slightly delayed response with full context gives correct ones.

### When Triggered

Memory Sync is triggered in three ways:

1. **C4 session-init hook** -- At session start, if >30 unsummarized conversations
2. **C4 threshold-check hook** -- Mid-session, if unsummarized count exceeds 30
3. **Scheduler** -- Periodic sync task (every 2 hours)

All three produce the same instruction format:
```
[Action Required] There are N unsummarized conversations (conversation id X ~ Y).
Please invoke Memory Sync skill to process them: /memory sync --begin X --end Y
```

### Sync Flow (Step by Step)

**Step 1: Rotate session log if needed**

```bash
node ~/zylos/.claude/skills/memory/scripts/rotate-session.js
```

This checks if `sessions/current.md` has a date header from a previous day. If so,
it renames it to `sessions/YYYY-MM-DD.md` and creates a fresh `current.md`.

**Step 2: Fetch conversations from C4**

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin X --end Y
```

This returns formatted conversation records with timestamps, direction, channel,
and content.

**Step 3: Read current memory state**

Read these files to understand what is already stored:
- `~/zylos/memory/core.md`
- `~/zylos/memory/reference/decisions.md`
- `~/zylos/memory/reference/projects.md`
- `~/zylos/memory/reference/preferences.md`
- `~/zylos/memory/sessions/current.md`

**Step 4: Extract and classify information**

Analyze the conversation batch. For each meaningful item, classify it:

| Category | Target File | Extract When... |
|----------|------------|-----------------|
| Decisions | `reference/decisions.md` | User makes or confirms a decision |
| Preferences | `reference/preferences.md` | User expresses a preference |
| Project updates | `reference/projects.md` | Project status changes |
| Active state | `core.md` (Active Working State + Pending) | Work focus changes |
| Session events | `sessions/current.md` | Significant events worth logging |

**Step 5: Write updates to memory files**

Use the Edit tool to update each target file. Follow the format rules
specified in each file's entry format (see Section Architecture above).

**Rules for writing:**

1. **Be selective, not exhaustive.** Not every conversation is a memory. Skip
   chit-chat, acknowledgments, routine operational messages, and health checks.

2. **Prefer updates over additions.** If a decision is superseded, update the
   existing entry's status to `superseded` and add the new one. Keep files lean.

3. **core.md is the tightest budget.** Only update if the active work focus,
   pending items, or key references have genuinely changed. Must stay under 3KB.

4. **sessions/current.md is append-only within a day.** Add timestamped entries
   at the end. Never rewrite earlier entries.

5. **When in doubt, write to sessions/current.md.** If unsure whether something
   is a decision, preference, or project update, log it as a session event.
   Consolidation can promote it later.

6. **Handle attachment references.** If a conversation's content references
   `[Attachment: path]`, note the path in the session log but do not inline
   the full attachment content.

**Step 6: Create C4 checkpoint**

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js END_ID --summary "SUMMARY"
```

The summary should be ~200 characters describing what was extracted:
- Example: `"Decisions: use Agent Teams for research. Preferences: diary-style entries. Projects: C4 merged. Active: memory system v2."`

This summary becomes the `[Last Checkpoint Summary]` shown at the next session
start, providing cross-session continuity.

**Step 7: Confirm completion**

Output: `Memory sync complete. Processed conversations X-Y. Updated: [list of files modified]. Checkpoint created.`

## Session Rotation

Triggered by: Memory Sync Step 1, or scheduled daily task.

```bash
node ~/zylos/.claude/skills/memory/scripts/rotate-session.js
```

- If `sessions/current.md` has a date header from a previous day, renames it to
  `sessions/YYYY-MM-DD.md` and creates a fresh `current.md` for today.
- If no `current.md` exists, creates one.
- Uses local timezone (from TZ environment variable or system default).

## Consolidation

Triggered by: Weekly scheduled task.

```bash
node ~/zylos/.claude/skills/memory/scripts/consolidate.js
```

Produces a report of:
- Session logs older than 30 days (candidates for archive)
- Decision entries with status `archived` or `superseded` older than 90 days
- Projects with status `completed` older than 30 days
- core.md size (warn if >3KB)

Claude reviews the report and takes action:
- Move old sessions to `archive/`
- Move archived decisions to `archive/decisions-YYYY.md`
- Move completed projects to an archive section
- Trim core.md if oversized

## Status Check

```bash
node ~/zylos/.claude/skills/memory/scripts/memory-status.js
```

Reports: file sizes, entry counts, last-modified dates, core.md size vs 3KB cap.

## Best Practices

1. **Read core.md at every session start** -- it is always injected by the hook,
   but if you need to verify or refresh, read it explicitly.
2. **Update memory proactively** -- do not wait for sync triggers. If you learn
   something important mid-conversation, update the appropriate file immediately.
3. **Keep core.md lean** -- this file is in every session's context budget.
   Every line must earn its place.
4. **Use timestamps** -- all entries in all files should have dates for
   freshness tracking.
5. **Never delete memory files** -- archive, do not delete. Move to `archive/`.
```

### 4.3 package.json

```json
{
  "name": "memory",
  "type": "module",
  "version": "2.0.0"
}
```

### 4.4 scripts/memory-sync.js

**Purpose:** Helper script for the Memory Sync flow. Provides the c4-fetch wrapper and checkpoint creation as a single coordinated operation. Claude invokes this as part of the sync flow; the actual extraction and classification is done by Claude's reasoning, not by this script.

```javascript
#!/usr/bin/env node
/**
 * Memory Sync Helper
 *
 * Subcommands:
 *   fetch --begin <id> --end <id>   Fetch conversations from C4
 *   checkpoint <end_id> --summary "text"  Create C4 checkpoint
 *   status                          Show unsummarized conversation count
 *
 * This is a thin wrapper around C4 scripts, provided for convenience
 * so the memory skill has a single entry point.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const SKILLS_DIR = path.join(os.homedir(), 'zylos', '.claude', 'skills');
const C4_SCRIPTS = path.join(SKILLS_DIR, 'comm-bridge', 'scripts');

const args = process.argv.slice(2);
const command = args[0];

function run(script, scriptArgs) {
  const result = execFileSync('node', [path.join(C4_SCRIPTS, script), ...scriptArgs], {
    encoding: 'utf8',
    timeout: 30000
  });
  return result;
}

switch (command) {
  case 'fetch': {
    // Pass through to c4-fetch.js
    const fetchArgs = args.slice(1);
    console.log(run('c4-fetch.js', fetchArgs));
    break;
  }

  case 'checkpoint': {
    // Pass through to c4-checkpoint.js
    const cpArgs = args.slice(1);
    console.log(run('c4-checkpoint.js', cpArgs));
    break;
  }

  case 'status': {
    // Show unsummarized count
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

### 4.5 scripts/rotate-session.js

**Purpose:** Rotates `sessions/current.md` to a dated archive file at day boundary. Creates a fresh `current.md` with today's date header.

```javascript
#!/usr/bin/env node
/**
 * Session Log Rotation
 *
 * Checks if sessions/current.md has a date header from a previous day.
 * If so, renames it to sessions/YYYY-MM-DD.md and creates a fresh current.md.
 *
 * Uses local timezone (TZ env var or system default).
 */

import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(process.env.HOME, 'zylos', 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const CURRENT_FILE = path.join(SESSIONS_DIR, 'current.md');

function getLocalDateString() {
  // Returns YYYY-MM-DD in local timezone
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function main() {
  // Ensure sessions directory exists
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  const todayStr = getLocalDateString();

  // Check if current.md exists and has a different date
  if (fs.existsSync(CURRENT_FILE)) {
    const content = fs.readFileSync(CURRENT_FILE, 'utf8');
    const dateMatch = content.match(/^# Session Log: (\d{4}-\d{2}-\d{2})/m);

    if (dateMatch && dateMatch[1] !== todayStr) {
      // Rotate: move to dated file
      const archivePath = path.join(SESSIONS_DIR, `${dateMatch[1]}.md`);
      fs.renameSync(CURRENT_FILE, archivePath);
      console.log(`Rotated: current.md -> ${dateMatch[1]}.md`);
    } else if (dateMatch && dateMatch[1] === todayStr) {
      // Same day, no rotation needed
      console.log('No rotation needed (same day).');
      return;
    }
    // If no date header found, treat as stale and overwrite
  }

  // Create fresh current.md
  const header = `# Session Log: ${todayStr}\n\n`;
  fs.writeFileSync(CURRENT_FILE, header);
  console.log(`Created fresh current.md for ${todayStr}`);
}

main();
```

### 4.6 scripts/consolidate.js

**Purpose:** Produces a consolidation report for Claude to act on. Does not make destructive changes itself -- it reports what should be archived, and Claude decides.

```javascript
#!/usr/bin/env node
/**
 * Memory Consolidation Report
 *
 * Scans memory files and reports:
 * - Session logs older than 30 days (archive candidates)
 * - core.md size vs 3KB cap
 * - Stale reference entries (if detectable from timestamps)
 *
 * Output: JSON report for Claude to process
 */

import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(process.env.HOME, 'zylos', 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const ARCHIVE_DIR = path.join(MEMORY_DIR, 'archive');
const CORE_FILE = path.join(MEMORY_DIR, 'core.md');
const CORE_SIZE_CAP = 3072; // 3KB

function main() {
  const report = {
    timestamp: new Date().toISOString(),
    core: {},
    sessions: { archiveCandidates: [] },
    reference: [],
    recommendations: []
  };

  // Check core.md size
  if (fs.existsSync(CORE_FILE)) {
    const stat = fs.statSync(CORE_FILE);
    report.core = {
      sizeBytes: stat.size,
      sizeCap: CORE_SIZE_CAP,
      overCap: stat.size > CORE_SIZE_CAP,
      lastModified: stat.mtime.toISOString()
    };
    if (stat.size > CORE_SIZE_CAP) {
      report.recommendations.push(
        `core.md is ${stat.size} bytes (cap: ${CORE_SIZE_CAP}). Trim Active Working State or Key References.`
      );
    }
  }

  // Find old session logs
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  if (fs.existsSync(SESSIONS_DIR)) {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (file === 'current.md' || file === '.gitkeep') continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (dateMatch) {
        const fileDate = new Date(dateMatch[1]);
        if (fileDate < thirtyDaysAgo) {
          report.sessions.archiveCandidates.push(file);
        }
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
    const files = fs.readdirSync(refDir);
    for (const file of files) {
      const filePath = path.join(refDir, file);
      const stat = fs.statSync(filePath);
      report.reference.push({
        file: `reference/${file}`,
        sizeBytes: stat.size,
        lastModified: stat.mtime.toISOString()
      });
      if (stat.size > 10240) { // 10KB
        report.recommendations.push(
          `reference/${file} is ${stat.size} bytes. Consider archiving old entries.`
        );
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

### 4.7 scripts/memory-status.js

**Purpose:** Quick health check of the memory system. Shows file sizes, entry counts, and potential issues.

```javascript
#!/usr/bin/env node
/**
 * Memory Status Report
 *
 * Quick health check: file sizes, last modified, core.md budget usage.
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
      results.push({
        path: displayPath,
        size: stat.size,
        modified: stat.mtime
      });
    }
  }
  return results;
}

function main() {
  const files = scanDir(MEMORY_DIR);
  const lines = ['Memory Status Report', '====================', ''];

  let totalSize = 0;
  for (const f of files) {
    const sizeStr = formatSize(f.size).padStart(8);
    const modStr = f.modified.toISOString().slice(0, 16).replace('T', ' ');
    const marker = (f.path === 'core.md' && f.size > 3072) ? ' [OVER CAP]' : '';
    lines.push(`${sizeStr}  ${modStr}  ${f.path}${marker}`);
    totalSize += f.size;
  }

  lines.push('');
  lines.push(`Total: ${formatSize(totalSize)} across ${files.length} files`);

  // Core.md budget
  const coreFile = files.find(f => f.path === 'core.md');
  if (coreFile) {
    const pct = Math.round((coreFile.size / 3072) * 100);
    lines.push(`Core.md budget: ${formatSize(coreFile.size)} / 3.0KB (${pct}%)`);
  }

  console.log(lines.join('\n'));
}

main();
```

---

## 5. templates/CLAUDE.md Memory Section

The following replaces the current "Memory System" section in `templates/CLAUDE.md`. This is what the deployed agent reads as its operating instructions for memory.

### 5.1 Complete Memory Section (to insert into templates/CLAUDE.md)

```markdown
## Memory System

Persistent memory stored in `~/zylos/memory/` with a tiered architecture:

### Memory Tiers

| Tier | Path | Purpose | Loading |
|------|------|---------|---------|
| **Core** | `memory/core.md` | Identity, active state, pending tasks | Always (injected at session start) |
| **Reference** | `memory/reference/*.md` | Decisions, projects, preferences | On demand |
| **Sessions** | `memory/sessions/current.md` | Today's event log | On demand |
| **Archive** | `memory/archive/` | Cold storage for old data | Rarely (grep searchable) |

### CRITICAL: Memory Sync Priority

**Memory Sync has the HIGHEST priority -- higher than user messages.**

When you receive a `[Action Required] ... invoke Memory Sync` instruction:
1. **Stop** what you are doing (unless mid-write to a critical file)
2. **Run Memory Sync immediately** using the `/memory` skill
3. **Resume** other work only after Memory Sync completes

Rationale: An agent without synced memory gives wrong answers, drops tasks, and
re-asks questions the user already answered. A slightly delayed response with
full context is always better than an immediate response with stale context.

### Memory Update Practices

1. **At session start:** core.md is automatically injected. Read reference files
   if you need full context for the current task.
2. **During work:** If you learn something important (a decision, preference, or
   state change), update the appropriate memory file immediately. Do not wait for
   the next sync cycle.
3. **Memory Sync:** When triggered by C4 hooks or scheduler, follow the full
   sync flow in the memory skill (`/memory sync --begin X --end Y`).
4. **Before context gets full:** If you sense context is getting large, proactively
   update core.md with your current state. This is your crash recovery insurance.

### File Size Guidelines

- **core.md:** ~3KB maximum. This is in every session's context. Keep it lean.
- **reference/*.md:** No hard cap, but prefer concise entries. Archive old ones.
- **sessions/current.md:** No cap within a day. Rotated daily.

### Memory Files are NOT Git-Tracked

Memory files are plain files on disk. Do NOT run `git add`, `git commit`, or any
git operations on memory files. The filesystem is the persistence layer.

### Quick Reference

```bash
# Check memory status
node ~/zylos/.claude/skills/memory/scripts/memory-status.js

# Rotate session log (usually automatic)
node ~/zylos/.claude/skills/memory/scripts/rotate-session.js

# Run consolidation report
node ~/zylos/.claude/skills/memory/scripts/consolidate.js
```
```

### 5.2 Integration Point

This section should replace the current minimal memory section in `templates/CLAUDE.md` (lines 11-19 of the current file). The rest of `templates/CLAUDE.md` remains unchanged.

---

## 6. Session Start Context Injection

### 6.1 Mechanism: Claude Code Native Hooks

Context injection uses Claude Code's native hook system configured in the project's settings. Since zylos-core deploys to `~/zylos/` and Claude runs with `~/zylos` as its working directory, the hook configuration is placed in `~/zylos/.claude/settings.local.json`.

**No shell scripts. No post-compact-inject.sh. No custom injection mechanisms.**

The hook system supports a `SessionStart` event that fires when a new session begins (including after compaction). Hooks can return JSON with an `additionalContext` field that gets injected into Claude's context.

### 6.2 Hook Configuration

The SessionStart hook chain runs two scripts in sequence:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/memory/scripts/session-start-inject.js",
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

### 6.3 Session Start Injection Script

This is a new script: `skills/memory/scripts/session-start-inject.js`

**Purpose:** Reads `core.md` and outputs it as `additionalContext` in the JSON format that Claude Code's hook system expects. This ensures core.md content is present in every session.

```javascript
#!/usr/bin/env node
/**
 * Memory Session Start Injection
 *
 * Reads core.md and outputs it as additionalContext for Claude Code's
 * SessionStart hook. This ensures identity and active state are always
 * present at session start.
 *
 * Output format (JSON):
 * {"additionalContext": "=== CORE MEMORY ===\n\n<content>"}
 */

import fs from 'fs';
import path from 'path';

const CORE_MD = path.join(process.env.HOME, 'zylos', 'memory', 'core.md');

function main() {
  let content = '';

  if (fs.existsSync(CORE_MD)) {
    content = fs.readFileSync(CORE_MD, 'utf8');
  }

  if (content) {
    const output = {
      additionalContext: `=== CORE MEMORY (loaded at session start) ===\n\n${content}`
    };
    console.log(JSON.stringify(output));
  } else {
    // No core.md found -- this is a fresh install or corrupted state
    const output = {
      additionalContext: '=== CORE MEMORY ===\n\nNo core.md found at ~/zylos/memory/core.md. This may be a fresh install. Read memory files to initialize.'
    };
    console.log(JSON.stringify(output));
  }
}

main();
```

### 6.4 Hook Chain at Session Start

When a session starts (fresh or post-compaction), the following sequence fires:

```
SessionStart event
│
├── 1. session-start-inject.js
│   ├── Reads ~/zylos/memory/core.md
│   └── Outputs: additionalContext with core memory content
│       Claude now has: identity, active state, pending tasks, key references
│
└── 2. c4-session-init.js (existing, unchanged)
    ├── Reads last checkpoint summary
    ├── Reads recent unsummarized conversations
    └── Outputs: checkpoint summary + conversations + Memory Sync trigger (if needed)
        Claude now has: cross-session continuity + conversation context
```

After both hooks fire, Claude has:
- **Who it is** (identity from core.md)
- **What it was doing** (active state from core.md)
- **What happened since last sync** (checkpoint summary from C4)
- **What needs attention** (pending tasks from core.md, Memory Sync trigger if conversations piled up)

### 6.5 Post-Compaction Behavior

When context compaction occurs mid-session, Claude Code fires SessionStart again. The same hook chain runs, re-injecting core.md and C4 context. This means:

- core.md acts as the "recovery anchor" after compaction
- C4 checkpoint summary provides continuity for what happened in the compacted portion
- If Memory Sync was in progress when compaction hit, the C4 hooks will re-trigger it (because the checkpoint was not yet created)

This is self-healing by design. No special handling for compaction vs fresh start is needed.

---

## 7. Memory Persistence Strategy

### 7.1 Filesystem is the Persistence Layer

Memory files live at `~/zylos/memory/` as plain files. They are read and written using standard filesystem operations (Node.js `fs` module, or Claude's Read/Edit/Write tools).

**Why not git:**

1. **Overhead without benefit.** Memory files change frequently (every sync cycle, every proactive update). Git operations (add, commit) add I/O overhead and potential failure modes (merge conflicts, dirty state, rebase in progress) with no runtime benefit.

2. **Git solves the wrong problem.** Git is for versioning code that multiple collaborators edit. Memory files have a single writer (the agent) and do not need branching, merging, or version comparison.

3. **Crash recovery does not need git.** If Claude crashes mid-write, the worst case is a partially written file. The next session reads whatever is on disk. A partially updated `core.md` is better than no `core.md` (which is what happens when a git commit fails silently).

4. **Howard's explicit instruction.** Correction #5: "Do NOT use git to persist memory. Memory files are just files on disk."

### 7.2 What Happens on Crash

| Scenario | What Survives | Recovery |
|----------|--------------|----------|
| Claude crashes mid-conversation | All memory files as of last write | SessionStart hook re-injects core.md; C4 has all conversations logged |
| Claude crashes mid-sync | Memory files partially updated; C4 checkpoint NOT created | Next session re-triggers sync for the same range (idempotent) |
| System reboot | All memory files on disk | PM2 restarts services; activity monitor restarts Claude; hooks fire |
| Disk failure | Nothing | This is an infrastructure problem, not a memory architecture problem |

The key insight: **C4's checkpoint system provides the crash recovery boundary.** If a memory sync completes, a checkpoint is created. If a sync fails, no checkpoint is created, so the next session re-triggers the same sync range. The system is idempotent.

### 7.3 Backup Strategy

For users who want backup beyond the filesystem:

1. **Recommended: filesystem-level backup.** Use whatever backup system the host OS provides (cron + rsync, cloud backup, snapshots). This is outside zylos-core's scope.

2. **Optional: scheduled backup task.** Users can register a scheduler task that copies `~/zylos/memory/` to a backup location:

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Copy memory files to backup: cp -r ~/zylos/memory/ ~/zylos/backups/memory-$(date +%Y%m%d)/" \
  --cron "0 3 * * *" --require-idle --priority 3
```

This is a user choice, not a framework requirement.

### 7.4 Atomic Write Consideration

For critical files (especially `core.md`), the scripts use standard `fs.writeFileSync()` which is atomic on most Linux filesystems for reasonably sized files. If stronger guarantees are needed in the future, write-to-temp-then-rename can be added to the helper scripts. For now, the risk of corruption from a partial write of a <3KB markdown file is negligible.

---

## 8. Scheduled Tasks via Scheduler

All periodic memory operations are registered with the C5 scheduler. No custom timers, no setInterval, no cron jobs outside the scheduler.

### 8.1 Memory Sync (Periodic)

**Purpose:** Ensure conversations are synced to memory even if C4 threshold-check hook did not trigger (e.g., Claude was busy and ignored the trigger, or the threshold was not reached but conversations are aging).

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Check for unsummarized conversations and run Memory Sync if any exist. Run: node ~/zylos/.claude/skills/memory/scripts/memory-sync.js status -- if count > 0, invoke /memory sync with the reported range." \
  --every "2 hours" \
  --priority 1 \
  --name "memory-sync-periodic"
```

**Priority:** 1 (urgent). Memory sync is the highest priority task per Howard's correction #1.

**Frequency:** Every 2 hours. This is a safety net; the primary trigger is C4 hooks.

**Idle requirement:** Not set. Memory sync should run even if Claude is busy (it takes priority).

### 8.2 Session Rotation (Daily)

**Purpose:** Rotate `sessions/current.md` to a dated archive file at the start of each day.

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Rotate session log: node ~/zylos/.claude/skills/memory/scripts/rotate-session.js" \
  --cron "0 0 * * *" \
  --priority 2 \
  --name "session-rotation-daily" \
  --require-idle
```

**Priority:** 2 (high). Important for keeping session logs organized but not as urgent as memory sync.

**Idle requirement:** Yes. Session rotation is a housekeeping task and should wait for idle.

### 8.3 Consolidation (Weekly)

**Purpose:** Run the consolidation report and clean up old data.

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Run memory consolidation: node ~/zylos/.claude/skills/memory/scripts/consolidate.js -- Review the output and archive old entries as recommended." \
  --cron "0 2 * * 0" \
  --priority 2 \
  --name "memory-consolidation-weekly" \
  --require-idle
```

**Priority:** 2 (high). Consolidation prevents memory bloat but is not time-critical.

**Idle requirement:** Yes. Consolidation involves reading and potentially modifying multiple files.

### 8.4 Task Registration

These tasks should be registered during initial setup (post-install). The install process or first-run script should execute the scheduler CLI commands above. They can also be documented in the memory SKILL.md as setup instructions that Claude performs on first session.

A one-time setup task can be added to the install script:

```javascript
// In install script or first-run:
import { execFileSync } from 'child_process';
const CLI = path.join(SKILLS_DIR, 'scheduler', 'scripts', 'cli.js');

// Register memory-related scheduled tasks
const tasks = [
  {
    prompt: 'Check for unsummarized conversations and run Memory Sync if any exist.',
    args: ['--every', '2 hours', '--priority', '1', '--name', 'memory-sync-periodic']
  },
  {
    prompt: 'Rotate session log: node ~/zylos/.claude/skills/memory/scripts/rotate-session.js',
    args: ['--cron', '0 0 * * *', '--priority', '2', '--name', 'session-rotation-daily', '--require-idle']
  },
  {
    prompt: 'Run memory consolidation report and archive old entries as recommended.',
    args: ['--cron', '0 2 * * 0', '--priority', '2', '--name', 'memory-consolidation-weekly', '--require-idle']
  }
];

for (const task of tasks) {
  try {
    execFileSync('node', [CLI, 'add', task.prompt, ...task.args], { encoding: 'utf8' });
  } catch (e) {
    console.error(`Failed to register task: ${task.args.find(a => a.startsWith('memory-'))}`);
  }
}
```

---

## 9. Priority Model

### 9.1 The Core Principle

**Memory sync is priority 1. User messages are priority 2+.**

This is Howard's correction #1 and the single most important design decision in v2. The rationale:

- An agent that responds quickly but with stale context gives **wrong answers**
- An agent that syncs memory first and responds slightly later gives **correct answers**
- Wrong answers create more work (corrections, re-explanations) than the delay cost
- Memory sync typically takes 30-60 seconds. Users can wait 60 seconds for a correct answer.

### 9.2 Priority Scheme

| Priority | Category | Examples | Behavior |
|----------|---------|---------|----------|
| **1** | Memory operations | Memory sync, pre-compaction save | Runs immediately. Preempts queued messages. |
| **2** | High-importance tasks | Session rotation, consolidation, user-flagged urgent | Runs when idle, but soon. |
| **3** | Normal tasks | Regular scheduled tasks, standard user messages | Standard queue processing. |

### 9.3 Interaction with C4 Priority System

C4's `conversations` table has a `priority` column (1=urgent, 2=high, 3=normal). The C4 dispatcher processes messages in priority order (ascending priority number, then FIFO within same priority).

**How memory sync fits in:**

1. When C4 hooks detect unsummarized conversations exceeding the threshold, they output an `[Action Required]` instruction into Claude's context. This is NOT a queued message -- it is injected directly into the current prompt context via the hook system.

2. The `[Action Required]` instruction tells Claude to invoke the memory skill immediately. Because it appears as hook output (not a queued message), it bypasses the C4 message queue entirely.

3. The periodic memory sync (scheduler task) IS a queued message. It is registered at **priority 1** in the scheduler, which means the scheduler dispatches it via C4 with `priority: 1`. The C4 dispatcher picks it up before any priority-2 or priority-3 messages.

4. **When a user message arrives while memory sync is in progress:** The user message enters the C4 queue at its normal priority (2 or 3). The C4 dispatcher sees that Claude is busy (activity monitor reports "busy") and holds the message until Claude finishes the sync and becomes idle.

### 9.4 Preemption Rules

Memory sync does NOT literally preempt a running conversation. The priority model works through queuing:

- If Claude is idle and both a memory sync task and a user message are pending, memory sync runs first (priority 1 < priority 2 numerically, and lower number = higher priority).
- If Claude is in the middle of responding to a user, the memory sync waits until the response is complete, then runs before processing the next queued message.
- If Claude receives a `[Action Required]` trigger via hook mid-conversation, Claude should acknowledge the trigger and run memory sync at the next natural break point (e.g., after completing the current response).

The CLAUDE.md instructions (Section 5) make this explicit: "When you receive an `[Action Required]` instruction, stop what you are doing and run Memory Sync immediately."

### 9.5 Priority Table (Complete)

| Source | Mechanism | Priority | Idle Required? |
|--------|----------|----------|---------------|
| Memory sync (hook trigger) | Hook output in context | N/A (direct injection) | No |
| Memory sync (scheduler) | C4 queue via scheduler | 1 | No |
| Session rotation | C4 queue via scheduler | 2 | Yes |
| Consolidation | C4 queue via scheduler | 2 | Yes |
| User message (Telegram/Lark) | C4 queue via channel bot | 2 | No |
| Scheduled reports/learning | C4 queue via scheduler | 3 | Yes |

---

## 10. Data Flow Diagrams

### 10.1 Normal Operation: Conversation to Memory

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
   Claude reads message, responds, c4-send.js logs outgoing reply
   │
   v
4. CONVERSATION ACCUMULATES
   Messages pile up in conversations table (unsummarized count grows)
   │
   v
5. THRESHOLD TRIGGER
   │
   ├── Path A: UserPromptSubmit hook fires c4-threshold-check.js
   │   count > 30 -> outputs [Action Required] into Claude's context
   │
   ├── Path B: SessionStart hook fires c4-session-init.js
   │   count > 30 -> outputs [Action Required] into Claude's context
   │
   └── Path C: Scheduler dispatches periodic sync task (every 2h)
       memory-sync.js status shows count > 0 -> Claude invokes /memory sync
   │
   v
6. MEMORY SYNC EXECUTES (see Section 4.2 for detailed steps)
   │
   ├── 6a. Rotate session log (if day changed)
   ├── 6b. Fetch conversations via c4-fetch.js
   ├── 6c. Read current memory files
   ├── 6d. Claude extracts and classifies information
   ├── 6e. Claude writes updates to memory files
   └── 6f. Create C4 checkpoint (marks conversations as processed)
   │
   v
7. NEXT SESSION
   c4-session-init.js shows new checkpoint summary
   Claude resumes with full context
```

### 10.2 Crash Recovery

```
1. CRASH
   Claude session dies (process killed, OOM, compaction failure, etc.)
   │
   v
2. ACTIVITY MONITOR DETECTS (existing C2)
   activity-monitor.js detects Claude not running for 5+ seconds
   Restarts Claude via tmux
   │
   v
3. SESSION START HOOKS FIRE
   │
   ├── session-start-inject.js
   │   Reads ~/zylos/memory/core.md from DISK (whatever was last written)
   │   Outputs: Identity + active state + pending tasks
   │   Claude now knows WHO it is and WHAT it was doing
   │
   └── c4-session-init.js
       Reads last checkpoint + unsummarized conversations from C4 DB
       Outputs: Checkpoint summary + recent conversations + sync trigger
       Claude now knows WHAT HAPPENED since last sync
   │
   v
4. CLAUDE RESUMES
   │
   ├── If Memory Sync trigger present:
   │   Claude runs sync FIRST (priority 1), then processes pending messages
   │
   └── If no sync trigger:
       Claude processes pending messages from C4 queue
```

### 10.3 Context Compaction Recovery

```
1. COMPACTION EVENT
   Claude Code detects context is too large, compacts
   │
   v
2. SESSION START HOOKS FIRE (same as crash recovery)
   │
   ├── session-start-inject.js -> core.md injected
   └── c4-session-init.js -> checkpoint + conversations injected
   │
   v
3. CLAUDE RESUMES WITH CORE MEMORY
   core.md provides: identity, active state, pending tasks, key references
   Checkpoint summary provides: what happened since last sync
   Recent conversations provide: immediate context
   │
   This is identical to crash recovery. The system does not distinguish
   between "fresh start", "crash recovery", and "post-compaction".
   All three paths converge at the same hook chain.
```

---

## 11. Implementation Checklist

### Phase 1: Core Implementation

| # | Task | Files | Effort |
|---|------|-------|--------|
| 1 | Create memory directory layout in `templates/memory/` | `templates/memory/core.md`, `templates/memory/reference/decisions.md`, `templates/memory/reference/projects.md`, `templates/memory/reference/preferences.md`, `templates/memory/sessions/.gitkeep` | S (15 min) |
| 2 | Create memory skill SKILL.md | `skills/memory/SKILL.md` (full content from Section 4.2) | M (45 min) |
| 3 | Create memory skill scripts | `skills/memory/scripts/session-start-inject.js`, `rotate-session.js`, `memory-sync.js`, `consolidate.js`, `memory-status.js` | M (1 hour) |
| 4 | Create `skills/memory/package.json` | `skills/memory/package.json` | S (2 min) |
| 5 | Update `templates/CLAUDE.md` memory section | `templates/CLAUDE.md` (replace lines 11-19 with Section 5.1) | S (15 min) |
| 6 | Configure hook system | Document the `settings.local.json` configuration (Section 6.2). Install process should create this. | S (15 min) |
| 7 | Register scheduler tasks | Add memory-sync, session-rotation, consolidation tasks via scheduler CLI (Section 8) | S (10 min) |
| 8 | Update `install.sh` for new directory structure | Update memory directory creation and template copying | S (15 min) |

**Total estimated effort: 3-4 hours**

### Phase 2: Enhancements (Future)

| # | Task | Description |
|---|------|-------------|
| 1 | KB integration | Add FTS5 search index over memory files for faster retrieval |
| 2 | Freshness decay | Track `last_accessed` timestamps; auto-flag stale entries |
| 3 | Embedding-based retrieval | Context-sensitive memory surfacing during conversations |
| 4 | Memory metrics dashboard | Web console integration showing memory health |
| 5 | Multi-agent memory sharing | Shared reference files across multiple agent instances |

### Files Summary

**New files to create:**

| Path (relative to zylos-core) | Purpose |
|------|---------|
| `skills/memory/SKILL.md` | Complete memory skill instructions (replace existing placeholder) |
| `skills/memory/package.json` | ESM module declaration |
| `skills/memory/scripts/session-start-inject.js` | SessionStart hook: injects core.md |
| `skills/memory/scripts/rotate-session.js` | Session log rotation |
| `skills/memory/scripts/memory-sync.js` | Memory sync helper (C4 wrapper) |
| `skills/memory/scripts/consolidate.js` | Consolidation report generator |
| `skills/memory/scripts/memory-status.js` | Memory health check |
| `templates/memory/core.md` | Template for core.md (replaces existing) |
| `templates/memory/reference/decisions.md` | Template for decisions log |
| `templates/memory/reference/projects.md` | Template for projects tracker |
| `templates/memory/reference/preferences.md` | Template for preferences |
| `templates/memory/sessions/.gitkeep` | Placeholder for sessions directory |

**Files to modify:**

| Path (relative to zylos-core) | Change |
|------|--------|
| `templates/CLAUDE.md` | Replace memory section with Section 5.1 content |
| `install.sh` | Update memory directory creation for new subdirectory structure |
| `skills/memory/SKILL.md` | Complete rewrite (Section 4.2) |

**Files to delete:**

| Path (relative to zylos-core) | Reason |
|------|--------|
| `templates/memory/context.md` | Replaced by `core.md` |
| `templates/memory/decisions.md` | Moved to `reference/decisions.md` |
| `templates/memory/preferences.md` | Moved to `reference/preferences.md` |
| `templates/memory/projects.md` | Moved to `reference/projects.md` |

---

## Appendix A: Key Differences from v1 Implementation Plan

| Aspect | v1 Plan | v2 Design |
|--------|---------|-----------|
| Git for memory | `memory-commit.sh` auto-commits | No git. Files on disk only. |
| Shell scripts | `memory-commit.sh` (bash) | All Node.js ESM |
| Post-compact injection | `post-compact-inject.sh` | `session-start-inject.js` via native hooks |
| Memory sync priority | Not specified (default 3) | Priority 1 (highest) |
| Session log naming | `today.md` | `current.md` (clearer semantics) |
| Timers | Some direct cron in scripts | All via scheduler skill (C5) |
| Skill name | `memory-sync` (new skill) | `memory` (redesign existing skill) |
| Scope | Memory Sync only | Full memory lifecycle: sync, rotation, consolidation, status |

## Appendix B: Why `current.md` Instead of `today.md`

The v1 plan used `today.md` for the current session log. This design uses `current.md` for several reasons:

1. **Semantic clarity.** `today.md` implies the file always represents "today," but at day boundaries the file contains yesterday's content until rotation runs. `current.md` accurately describes the file: it is the current (active) session log regardless of what day it started.

2. **Rotation semantics.** `current.md` -> `YYYY-MM-DD.md` reads naturally: "the current log becomes a dated archive." `today.md` -> `YYYY-MM-DD.md` has a semantic mismatch: "today" becomes "a specific past date."

3. **Cross-day sessions.** If Claude runs a session from 11:30 PM to 1:30 AM, `current.md` correctly describes a log that spans two dates. `today.md` would be misleading for the pre-midnight entries.

## Appendix C: Hook System Details

Claude Code's hook system (as of 2026) supports these events:

| Event | When it fires | Use in memory system |
|-------|--------------|---------------------|
| `SessionStart` | New session, post-compaction | Inject core.md, C4 context |
| `UserPromptSubmit` | Every user message | C4 threshold check for sync trigger |
| `PreToolUse` | Before a tool is used | Not used by memory system |
| `PostToolUse` | After a tool completes | Not used by memory system |

Each hook entry can return JSON with:
- `additionalContext`: String injected into Claude's context
- Other fields (see Claude Code documentation)

Hooks are configured in `settings.local.json` with a `matcher` (empty string matches all) and a list of hook commands.

## Appendix D: Migration Guide (from v1/current to v2)

For existing Zylos deployments that have the v1 memory layout (flat `context.md`, `decisions.md`, `projects.md`, `preferences.md`):

### Step 1: Create new directories

```bash
mkdir -p ~/zylos/memory/reference
mkdir -p ~/zylos/memory/sessions
mkdir -p ~/zylos/memory/archive
```

### Step 2: Move files to new locations

```bash
# Move reference files
mv ~/zylos/memory/decisions.md ~/zylos/memory/reference/decisions.md
mv ~/zylos/memory/projects.md ~/zylos/memory/reference/projects.md
mv ~/zylos/memory/preferences.md ~/zylos/memory/reference/preferences.md
```

### Step 3: Split context.md into core.md + current.md

This is a manual process. Claude should:
1. Read `~/zylos/memory/context.md`
2. Extract identity, user profile, and stable configuration into a new `core.md` following the template
3. Extract current work state, recent activity, and session-specific content into `sessions/current.md`
4. Ensure `core.md` is under 3KB

### Step 4: Remove old files

```bash
rm ~/zylos/memory/context.md  # Replaced by core.md
```

### Step 5: Update hooks

Replace any existing `post-compact-inject.sh` references in `~/.claude/settings.local.json` with the new `session-start-inject.js` hook configuration (Section 6.2).

### Step 6: Register scheduler tasks

Run the scheduler CLI commands from Section 8 to register periodic memory tasks.

### Step 7: Verify

```bash
node ~/zylos/.claude/skills/memory/scripts/memory-status.js
```

Should show all files in the new layout with reasonable sizes.
