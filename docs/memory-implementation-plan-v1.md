# Phase 1 Memory Implementation Plan (No KB Dependency)

**Date:** 2026-02-07
**Author:** impl-planner (memory-impl team, Task #2)
**Prerequisites:** [C4 Capabilities Report](c4-capabilities-for-memory.md), [Inside Out Proposal](memory-inside-out-proposal.md), [Proposal Review](memory-inside-out-review.md)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Phase 1 Scope: Inside Out Mechanism Mapping](#2-phase-1-scope-inside-out-mechanism-mapping)
3. [Memory Sync Skill Design (Core Deliverable)](#3-memory-sync-skill-design-core-deliverable)
4. [Implementation Tasks](#4-implementation-tasks)
5. [Hook Integration](#5-hook-integration)
6. [Data Flow](#6-data-flow)
7. [Migration Plan](#7-migration-plan)
8. [Testing Strategy](#8-testing-strategy)
9. [Phase 2 Preview](#9-phase-2-preview)
10. [Review Revision Responses](#10-review-revision-responses)

---

## 1. Architecture Overview

### How Memory Integrates with C4

C4 (Communication Bridge) already provides the **conversation lifecycle pipeline**. The Memory Sync skill plugs into this pipeline as the **processing stage** -- it reads raw conversations, extracts structured memory, and writes to persistent files.

```
                        EXISTING (C4)                         NEW (Memory Sync)
                        =============                         =================

External Messages ──► c4-receive.js ──► conversations table
                                             |
                                             ├── count > 30?
                                             |     |
                  c4-session-init.js ◄───────┤     ├── c4-threshold-check.js
                  (session start hook)       |     |   (user message hook)
                                             |     |
                                             |     └──► "[Action Required] invoke /memory-sync"
                                             |                    |
                                             |                    v
                                             |          ┌─────────────────────┐
                                             |          │   MEMORY SYNC SKILL  │
                                             |          │                      │
                                             └────────► │ 1. c4-fetch.js      │
                                                        │    (read convos)     │
                                                        │                      │
                                                        │ 2. Extract memories  │
                                                        │    (parse + classify)│
                                                        │                      │
                                                        │ 3. Update files      │
                                                        │    core.md           │
                                                        │    reference/*.md    │
                                                        │    sessions/today.md │
                                                        │                      │
                                                        │ 4. Git commit        │
                                                        │                      │
                                                        │ 5. c4-checkpoint.js  │
                                                        │    (mark processed)  │
                                                        └─────────────────────┘
```

### Key Architectural Decisions

1. **C4 DB is the conversation source of truth.** Memory Sync reads from it; it never writes to it (except via checkpoint).
2. **Memory files are the memory source of truth.** The sync skill writes structured extracts to markdown files tracked by git.
3. **No KB dependency.** Phase 1 uses files + git only. Retrieval is via grep and a generated index file.
4. **Claude does the extraction.** The Memory Sync skill is a Claude Code skill (SKILL.md), not a background script. Claude reads conversations and uses its reasoning to decide what to extract and where to write. This is deliberate -- extraction quality matters more than automation speed.
5. **Checkpoint = sync boundary.** After Memory Sync processes a batch, it creates a checkpoint with a structured summary. The next session-init shows this summary for continuity.

---

## 2. Phase 1 Scope: Inside Out Mechanism Mapping

### Mechanisms Included in Phase 1

| # | Inside Out Mechanism | Phase 1 Implementation | Status |
|---|---------------------|----------------------|--------|
| 1 | **Core Memories** (protected identity) | `memory/core.md` -- structured, size-capped (~3KB), always injected at session start | **Build** |
| 2 | **Headquarters** (working memory) | Context window management via hooks (session-init injects core.md + checkpoint summary) | **Build** |
| 3 | **Long-Term Memory** (persistent storage) | Tiered file layout: `memory/reference/`, `memory/sessions/`, `memory/archive/` | **Build** |
| 4 | **Dream Production** (idle-time consolidation) | Memory Sync skill (triggered by C4 threshold) + periodic git commit | **Build** |
| 5 | **Memory Dump** (graduated deletion) | Git history as non-destructive archive; `memory/archive/` for cold storage | **Build** |
| 6 | **Personality Islands** (behavioral modules) | Existing skills + CLAUDE.md sections (descriptive mapping, no new build) | **Map only** |

### Mechanisms Deferred to Phase 2

| # | Inside Out Mechanism | Why Deferred | Phase 2 Enabler |
|---|---------------------|-------------|-----------------|
| 7 | **Emotional Coloring** (rich metadata) | Structured metadata columns need KB; file markers are fragile | KB `memory_type`, `freshness` columns |
| 8 | **Recall Tubes + Train of Thought** (retrieval) | Associative retrieval needs embeddings; targeted retrieval via grep works for Phase 1 scale | KB FTS5 + embedding similarity |
| 9 | **Memory Fading** (freshness decay) | Automated decay needs structured timestamps; git blame is a rough proxy | KB `last_accessed` + `access_count` |
| 10 | **Abstract Thought** (multi-level abstraction) | Middle abstraction tier (summaries between raw and tags) needs KB entries | KB entries as Level 2 summaries |

**Phase 1 delivers 5 of 10 mechanisms as working implementations and 1 as a mapping. This covers the highest-impact pain points (P1, P2, P3, P5, P9, P10) and provides a functional standalone system.**

---

## 3. Memory Sync Skill Design (Core Deliverable)

### 3.1 What It Is

A Claude Code skill at `skills/memory-sync/` that Claude invokes (or is triggered to invoke by C4 hooks) to process unsummarized conversations into structured memory files. This is the **missing piece** that C4 hooks already reference but does not exist.

### 3.2 SKILL.md Frontmatter

```yaml
---
name: memory-sync
description: >-
  Process unsummarized conversations from C4 database into structured memory files.
  Invoke when C4 hooks report unsummarized conversations exceeding threshold,
  or periodically to keep memory current. Reads conversations via c4-fetch.js,
  extracts decisions/preferences/tasks/context updates, writes to memory files,
  commits to git, and creates a C4 checkpoint.
argument-hint: --begin <id> --end <id>
allowed-tools: Read, Edit, Write, Bash, Grep
---
```

### 3.3 Step-by-Step Flow

When Claude receives `[Action Required] ... invoke Memory Sync skill: /memory-sync --begin X --end Y`:

**Step 1: Fetch conversations from C4 DB**

```bash
node ~/zylos/zylos-core/skills/comm-bridge/scripts/c4-fetch.js --begin X --end Y
```

Output: formatted conversation text with timestamps, direction, channel, and content.

**Step 2: Read current memory state**

Read these files to understand what's already stored:
- `~/zylos/memory/core.md` (identity + active state)
- `~/zylos/memory/reference/decisions.md` (active decisions)
- `~/zylos/memory/reference/projects.md` (active projects)
- `~/zylos/memory/reference/preferences.md` (user preferences)
- `~/zylos/memory/sessions/today.md` (today's session log)

**Step 3: Extract and classify memory items**

Claude analyzes the conversation batch and extracts items into categories:

| Category | Target File | Extract When... |
|----------|------------|----------------|
| **Decisions** | `reference/decisions.md` | Howard makes or confirms a decision ("let's do X", "yes, go with Y") |
| **Preferences** | `reference/preferences.md` | Howard expresses a preference ("I prefer X", "don't do Y") |
| **Project updates** | `reference/projects.md` | A project status changes (started, completed, blocked) |
| **Active state** | `core.md` | Current work focus changes, key references change |
| **Session events** | `sessions/today.md` | Significant events, completions, errors worth logging |

**Step 4: Write updates to memory files**

For each extracted item, Claude uses the Edit tool (or Write for new sections) to update the appropriate file. Format rules:

```markdown
## decisions.md entry format
### [YYYY-MM-DD] Decision Title
- **Decision:** What was decided
- **Context:** Why (1 sentence)
- **Status:** active | superseded | archived

## preferences.md entry format
### Preference Name
- **Value:** The preference
- **Source:** conversation/observation
- **Added:** YYYY-MM-DD

## projects.md entry format
### Project Name
- **Status:** active | completed | blocked | planned
- **Updated:** YYYY-MM-DD
- **Notes:** Current state (2-3 sentences max)

## sessions/today.md entry format
**HH:MM** - Brief description of event/completion/issue

## core.md -- only update the "Active Working State" and "Key References" sections
```

**Step 5: Git commit the memory changes**

```bash
cd ~/zylos && git add memory/ && git diff --cached --quiet || git commit -m "Memory sync: conversations $BEGIN-$END"
```

The commit message includes the conversation ID range for traceability.

**Step 6: Create C4 checkpoint**

```bash
node ~/zylos/zylos-core/skills/comm-bridge/scripts/c4-checkpoint.js $END_ID --summary "SUMMARY_TEXT"
```

The summary should be a concise (~200 char) description of what was extracted:
- Example: `"Decisions: use Agent Teams for research. Preferences: diary-style timeline entries. Projects: C4 optimization merged. Active: memory system implementation."`

This summary becomes the `[Last Checkpoint Summary]` shown at the next session start, providing cross-session continuity.

**Step 7: Confirm completion**

Output to Claude's context: `Memory sync complete. Processed conversations X-Y. Updated: [list of files modified]. Checkpoint created.`

### 3.4 Extraction Guidelines (In SKILL.md)

The SKILL.md will contain these guidelines for Claude's extraction behavior:

1. **Be selective, not exhaustive.** Not every conversation is a memory. Skip chit-chat, acknowledgments, and routine operational messages (health checks, status reports with no new info).

2. **Prefer updates over additions.** If a decision in `decisions.md` is superseded by a new one, update the existing entry's status to `superseded` and add the new decision. Don't let the file grow unboundedly.

3. **core.md is the tightest budget.** Only update `core.md` if the active work focus or key references have genuinely changed. core.md should stay under 3KB.

4. **sessions/today.md is append-only within a day.** Add timestamped entries. At the start of each day, the previous today.md is moved to `sessions/YYYY-MM-DD.md`.

5. **When in doubt, write to sessions/today.md.** If you're unsure whether something is a decision, preference, or project update, log it as a session event. The weekly consolidation (future) can promote it later.

6. **Handle attachment references.** If a conversation's content contains `[Attachment: path/to/file]`, note the attachment path in the session log but don't try to inline the full content.

### 3.5 File Structure for the Skill

```
skills/memory-sync/
├── SKILL.md                    # Full instructions for Claude
├── package.json                # {"type":"module"}
├── scripts/
│   ├── memory-commit.sh        # Git add+commit memory files (used by Stop hook too)
│   └── rotate-session.js       # Rotate today.md -> YYYY-MM-DD.md at day boundary
└── templates/
    ├── core.md                 # Template for memory/core.md structure
    ├── decisions.md            # Template for reference/decisions.md structure
    ├── projects.md             # Template for reference/projects.md structure
    ├── preferences.md          # Template for reference/preferences.md structure
    └── session-day.md          # Template for sessions/today.md header
```

---

## 4. Implementation Tasks

### Task 1: Create memory file layout

**Files to create:**

| Path | Purpose | Size |
|------|---------|------|
| `~/zylos/memory/core.md` | Identity anchor, always loaded | ~3KB cap |
| `~/zylos/memory/index.md` | Table of contents for all memory | ~1-2KB |
| `~/zylos/memory/reference/decisions.md` | Active decisions (migrated from current `decisions.md`) | Variable |
| `~/zylos/memory/reference/projects.md` | Active projects (migrated from current `projects.md`) | Variable |
| `~/zylos/memory/reference/preferences.md` | User preferences (migrated from current `preferences.md`) | Variable |
| `~/zylos/memory/sessions/today.md` | Current day's session log | Variable |
| `~/zylos/memory/archive/` | Directory for archived sessions and sunset items | Empty initially |

**`core.md` template:**

```markdown
# Core Memory

**Identity:** I am Zylos, Howard's AI companion. Day N.

## User Profile
- Name: Howard Zhou
- Communication: Telegram (primary), Lark (work), English practice
- Principles: simplicity > complexity, 借势, quality > quantity

## Active Working State
[What I'm currently focused on -- update during memory sync]

## Key References
[Paths, IDs, URLs relevant to current work -- update during memory sync]

## Services
[Critical service list -- update only when services change]
```

**Migration from current files:**
- `~/zylos/memory/context.md` -> Split into `core.md` (stable identity) + `sessions/today.md` (session log). `context.md` kept temporarily as a symlink to `core.md` for backward compatibility.
- `~/zylos/memory/decisions.md` -> Move to `reference/decisions.md`
- `~/zylos/memory/projects.md` -> Move to `reference/projects.md`
- `~/zylos/memory/preferences.md` -> Move to `reference/preferences.md`

### Task 2: Build Memory Sync skill

**Files to create in `~/zylos/zylos-core/skills/memory-sync/`:**

**`SKILL.md`** -- Full Claude instructions (as designed in Section 3). Contains:
- Frontmatter with name, description, argument-hint, allowed-tools
- Step-by-step sync flow (fetch -> read -> extract -> write -> commit -> checkpoint)
- Extraction guidelines (Section 3.4)
- File format rules
- Error handling instructions

**`package.json`:**
```json
{
  "name": "memory-sync",
  "type": "module",
  "version": "1.0.0"
}
```

**`scripts/memory-commit.sh`:**
```bash
#!/bin/bash
# Auto-commit memory files to git.
# Called by: Memory Sync skill (step 5), Stop hook
# Safe to call repeatedly -- no-ops if nothing changed.

set -euo pipefail
MEMORY_DIR="${HOME}/zylos/memory"
cd "${HOME}/zylos"

# Guard: skip if git is in a conflicted state
if [ -f .git/MERGE_HEAD ] || [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    echo "[memory-commit] Git in conflicted state, skipping commit" >&2
    exit 0
fi

# Stage memory files
git add memory/ 2>/dev/null || true

# Check if there are staged changes
if git diff --cached --quiet; then
    # Nothing to commit
    exit 0
fi

# Commit with timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
git commit -m "Memory auto-save: ${TIMESTAMP}" --no-verify 2>/dev/null || true
```

**`scripts/rotate-session.js`:**
```javascript
#!/usr/bin/env node
/**
 * Rotate today's session log if the date has changed.
 * Moves sessions/today.md -> sessions/YYYY-MM-DD.md
 * Creates a fresh today.md with the new date header.
 *
 * Called by: Memory Sync skill (before processing), or daily scheduled task.
 */

import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(process.env.HOME, 'zylos', 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const TODAY_FILE = path.join(SESSIONS_DIR, 'today.md');

function main() {
    // Ensure sessions directory exists
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Check if today.md exists and has a different date
    if (fs.existsSync(TODAY_FILE)) {
        const content = fs.readFileSync(TODAY_FILE, 'utf8');
        const dateMatch = content.match(/^# Session Log: (\d{4}-\d{2}-\d{2})/m);

        if (dateMatch && dateMatch[1] !== todayStr) {
            // Rotate: move to dated file
            const archivePath = path.join(SESSIONS_DIR, `${dateMatch[1]}.md`);
            fs.renameSync(TODAY_FILE, archivePath);
            console.log(`Rotated: today.md -> ${dateMatch[1]}.md`);
        } else if (dateMatch && dateMatch[1] === todayStr) {
            // Same day, no rotation needed
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

### Task 3: Update session-init hook to inject core.md

**File to modify:** `/home/howard/.claude/hooks/post-compact-inject.sh`

Currently injects only `~/zylos/CLAUDE.md`. Update to also inject `~/zylos/memory/core.md` content:

```bash
#!/bin/bash
# Session start hook: Inject CLAUDE.md + core.md after compaction/session start

CLAUDE_MD="/home/howard/zylos/CLAUDE.md"
CORE_MD="/home/howard/zylos/memory/core.md"

CONTENT=""

if [ -f "$CLAUDE_MD" ]; then
    CONTENT=$(cat "$CLAUDE_MD")
fi

if [ -f "$CORE_MD" ]; then
    CORE_CONTENT=$(cat "$CORE_MD")
    CONTENT="${CONTENT}

=== CORE MEMORY (always loaded) ===

${CORE_CONTENT}"
fi

if [ -n "$CONTENT" ]; then
    jq -n --arg content "$CONTENT" '{
        "additionalContext": ("=== CLAUDE.md RELOADED AFTER COMPACTION ===\n\nThe following are your critical instructions from CLAUDE.md. Follow them carefully:\n\n" + $content)
    }'
else
    echo '{"additionalContext": "WARNING: Neither CLAUDE.md nor core.md found"}'
fi
```

**Additionally**, add C4 session-init to the SessionStart hook chain (if not already there) in `~/.claude/settings.local.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/home/howard/.claude/hooks/post-compact-inject.sh",
            "timeout": 10000
          },
          {
            "type": "command",
            "command": "node /home/howard/zylos/zylos-core/skills/comm-bridge/scripts/c4-session-init.js",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

This ensures that at session start, Claude receives:
1. CLAUDE.md instructions (behavioral rules)
2. core.md content (identity + active state)
3. C4 checkpoint summary + recent conversations + Memory Sync trigger if needed

### Task 4: Add C4 threshold-check to user-message hook

**File to modify:** `~/.claude/settings.local.json`

Add C4 threshold check to the existing `UserPromptSubmit` hooks array:

```json
{
  "type": "command",
  "command": "node /home/howard/zylos/zylos-core/skills/comm-bridge/scripts/c4-threshold-check.js",
  "timeout": 5000
}
```

This ensures that even mid-session, if conversations pile up beyond the threshold (30), Claude is prompted to run Memory Sync.

### Task 5: Create memory index file

**File:** `~/zylos/memory/index.md`

```markdown
# Memory Index

Last updated: YYYY-MM-DD (updated by Memory Sync)

## Core (Always Loaded)
- `core.md` - Identity, user profile, active state, key references (~3KB)

## Reference (Load on Demand)
- `reference/decisions.md` - Active decisions constraining behavior (N entries)
- `reference/projects.md` - Active and planned projects (N active)
- `reference/preferences.md` - Howard's preferences and working style (N entries)

## Sessions
- `sessions/today.md` - Today's session log
- `sessions/YYYY-MM-DD.md` - Previous session logs

## Archive
- `archive/` - Rotated old sessions, superseded decisions

## Learning (External, grep-searchable)
- `~/zylos/learning/*.md` - Full research documents
```

The Memory Sync skill updates the entry counts and date each time it runs.

### Task 6: Update the existing memory SKILL.md

**File to modify:** `~/zylos/zylos-core/skills/memory/SKILL.md`

Update to reflect the new file layout, reference the Memory Sync skill, and describe the tiered system:

```yaml
---
name: memory
description: >-
  Persistent memory system for cross-session context.
  Tiered architecture: core.md (always loaded), reference/ (on demand),
  sessions/ (daily logs), archive/ (cold storage), git (ultimate backup).
  Memory Sync skill processes C4 conversations into structured files.
user-invocable: false
---
```

### Summary: All Files to Create or Modify

| Action | Path | Description |
|--------|------|-------------|
| **Create** | `skills/memory-sync/SKILL.md` | Memory Sync skill instructions |
| **Create** | `skills/memory-sync/package.json` | ESM module config |
| **Create** | `skills/memory-sync/scripts/memory-commit.sh` | Git commit script |
| **Create** | `skills/memory-sync/scripts/rotate-session.js` | Session log rotation |
| **Create** | `skills/memory-sync/templates/core.md` | Template for core.md |
| **Create** | `skills/memory-sync/templates/decisions.md` | Template for decisions |
| **Create** | `skills/memory-sync/templates/projects.md` | Template for projects |
| **Create** | `skills/memory-sync/templates/preferences.md` | Template for preferences |
| **Create** | `skills/memory-sync/templates/session-day.md` | Template for session log |
| **Create** | `~/zylos/memory/core.md` | Core identity file (from template) |
| **Create** | `~/zylos/memory/index.md` | Memory table of contents |
| **Create** | `~/zylos/memory/reference/` | Directory for reference files |
| **Create** | `~/zylos/memory/sessions/` | Directory for session logs |
| **Create** | `~/zylos/memory/archive/` | Directory for cold storage |
| **Move** | `decisions.md` -> `reference/decisions.md` | Restructure |
| **Move** | `projects.md` -> `reference/projects.md` | Restructure |
| **Move** | `preferences.md` -> `reference/preferences.md` | Restructure |
| **Split** | `context.md` -> `core.md` + `sessions/today.md` | Separate identity from session |
| **Modify** | `~/.claude/hooks/post-compact-inject.sh` | Add core.md injection |
| **Modify** | `~/.claude/settings.local.json` | Add C4 hooks to session start + user message |
| **Modify** | `skills/memory/SKILL.md` | Update to reflect new architecture |

---

## 5. Hook Integration

### Hook Chain After Implementation

```
EVENT: SessionStart
├── post-compact-inject.sh
│   ├── Injects CLAUDE.md content (behavioral rules)
│   └── Injects core.md content (identity + active state)  [NEW]
└── c4-session-init.js  [NEW hook entry]
    ├── Shows last checkpoint summary (cross-session continuity)
    ├── Shows recent conversations (if any)
    └── Triggers Memory Sync if >30 unsummarized conversations

EVENT: UserPromptSubmit (every message)
├── check-telegram.sh (existing)
├── telegram-reply-check.sh (existing)
├── context-monitor.sh (existing)
└── c4-threshold-check.js  [NEW hook entry]
    └── Triggers Memory Sync if >30 unsummarized conversations (silent otherwise)

EVENT: Stop (not yet implemented -- future)
└── memory-commit.sh  [FUTURE]
    └── Auto-commits memory/ to git
```

**Note on Stop hook:** Claude Code's hook system currently supports `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`. A `Stop` hook is not currently available in the hook system. The auto-commit on session end will instead be handled by:
1. Memory Sync creating a checkpoint (which implicitly saves state)
2. The `memory-commit.sh` script being called manually or by a scheduled task
3. Future: If Claude Code adds a Stop/SessionEnd hook, wire `memory-commit.sh` to it

### C4 Config: No Changes Needed

The existing `CHECKPOINT_THRESHOLD = 30` and `SESSION_INIT_RECENT_COUNT = 6` are reasonable defaults. The Memory Sync skill works with these as-is.

---

## 6. Data Flow

### Complete Message-to-Memory Flow

```
1. MESSAGE ARRIVES
   Howard sends "let's use Agent Teams for research" via Telegram
   │
   v
2. C4 RECEIVE (existing)
   telegram-bot -> c4-receive.js -> INSERT into conversations table
   Row: {id: 142, direction: 'in', channel: 'telegram', content: "let's use..."}
   │
   v
3. C4 DISPATCH (existing)
   c4-dispatcher.js detects pending message -> delivers to Claude via tmux
   │
   v
4. CLAUDE PROCESSES (existing)
   Claude reads message, responds, c4-send.js logs the outgoing reply
   Row: {id: 143, direction: 'out', channel: 'telegram', content: "Got it..."}
   │
   v
5. THRESHOLD CHECK (NEW hook integration)
   On next user message, c4-threshold-check.js runs:
   - getUnsummarizedRange() returns {count: 35, begin_id: 108, end_id: 143}
   - count (35) > CHECKPOINT_THRESHOLD (30)
   - Outputs: "[Action Required] invoke /memory-sync --begin 108 --end 143"
   │
   v
6. MEMORY SYNC INVOKED (NEW skill)
   Claude sees the [Action Required] prompt and invokes /memory-sync --begin 108 --end 143
   │
   ├── 6a. FETCH: node c4-fetch.js --begin 108 --end 143
   │   Returns 36 formatted conversation records
   │
   ├── 6b. READ: Claude reads current memory files
   │   - core.md, reference/decisions.md, reference/projects.md, etc.
   │
   ├── 6c. EXTRACT: Claude analyzes conversations and identifies:
   │   - Decision: "Use Agent Teams for research tasks" -> decisions.md
   │   - Preference: "diary-style timeline entries" -> preferences.md
   │   - Project: "C4 optimization merged" -> projects.md (status update)
   │   - Session: "07:15 Lark Bot lazy download implemented" -> sessions/today.md
   │   - State: "Focus: memory system implementation" -> core.md
   │
   ├── 6d. WRITE: Claude uses Edit tool to update each file
   │
   ├── 6e. COMMIT: bash memory-commit.sh
   │   git add memory/ && git commit -m "Memory sync: conversations 108-143"
   │
   └── 6f. CHECKPOINT: node c4-checkpoint.js 143 --summary "Decisions: Agent Teams..."
       Creates checkpoint {id: 5, start: 108, end: 143, summary: "..."}
   │
   v
7. NEXT SESSION START
   c4-session-init.js runs:
   - Shows: "[Last Checkpoint Summary] Decisions: Agent Teams for research..."
   - Shows: recent conversations after id 143 (if any)
   - Claude has continuity without reading all past conversations
```

### Data Flow for Session Recovery (Crash/Restart)

```
1. CRASH OCCURS
   Claude session dies unexpectedly
   │
   v
2. ACTIVITY MONITOR DETECTS (existing C2)
   After timeout, activity-monitor restarts Claude session
   │
   v
3. SESSION START HOOK FIRES
   ├── post-compact-inject.sh: Injects CLAUDE.md + core.md
   │   Claude now has: behavioral rules + identity + active state
   │
   └── c4-session-init.js: Shows checkpoint summary + recent conversations
       Claude now has: what happened since last sync + any new messages
   │
   v
4. CLAUDE RESUMES
   With core.md (who am I, what was I doing) + checkpoint summary (what happened
   since last sync) + recent conversations (what's pending), Claude can resume work
   without reading all history files.
```

---

## 7. Migration Plan

### Migration Strategy: Incremental, Reversible

Each step can be independently rolled back with `git checkout`. No step depends on a later step being complete.

### Step 1: Create directory structure (low risk)

```bash
mkdir -p ~/zylos/memory/reference
mkdir -p ~/zylos/memory/sessions
mkdir -p ~/zylos/memory/archive
```

**Rollback:** `rm -rf ~/zylos/memory/reference ~/zylos/memory/sessions ~/zylos/memory/archive`

### Step 2: Migrate existing files (low risk)

```bash
cd ~/zylos/memory

# Move reference files
git mv decisions.md reference/decisions.md
git mv projects.md reference/projects.md
git mv preferences.md reference/preferences.md

# Create core.md from context.md (extract stable parts)
# This is manual -- Claude reads context.md and writes core.md with the template

# Keep context.md as symlink for backward compatibility
ln -sf core.md context.md

git add -A
git commit -m "Memory restructure: tiered file layout"
```

**Rollback:** `git checkout HEAD~1 -- memory/`

**Pass/fail criteria:**
- PASS: `ls ~/zylos/memory/reference/decisions.md` exists and has content
- PASS: `cat ~/zylos/memory/core.md` shows structured template with identity info
- PASS: `readlink ~/zylos/memory/context.md` shows `core.md`

### Step 3: Deploy Memory Sync skill (low risk)

Copy the `skills/memory-sync/` directory from zylos-core to the deployed skills location. No system changes -- just files added to the repository.

**Rollback:** `git rm -r skills/memory-sync/`

**Pass/fail criteria:**
- PASS: `cat ~/zylos/zylos-core/skills/memory-sync/SKILL.md` shows full instructions
- PASS: `bash ~/zylos/zylos-core/skills/memory-sync/scripts/memory-commit.sh` runs without error (may be a no-op if nothing to commit)
- PASS: `node ~/zylos/zylos-core/skills/memory-sync/scripts/rotate-session.js` creates `sessions/today.md` if it doesn't exist

### Step 4: Update hooks (medium risk -- test carefully)

Update `~/.claude/settings.local.json` to add C4 session-init and threshold-check hooks.

**Test process:**
1. Back up: `cp ~/.claude/settings.local.json ~/.claude/settings.local.json.backup`
2. Add the new hook entries
3. Start a new Claude session
4. Verify: session start output includes `[Last Checkpoint Summary]` or `No new conversations`
5. Verify: sending a message doesn't produce unexpected errors

**Rollback:** `cp ~/.claude/settings.local.json.backup ~/.claude/settings.local.json`

**Pass/fail criteria:**
- PASS: New Claude session shows C4 context output (checkpoint summary or "no new conversations")
- PASS: core.md content appears in session context
- FAIL: Hook errors visible in session start, OR Claude doesn't receive CLAUDE.md instructions

### Step 5: Update session-start hook to inject core.md (medium risk)

Modify `post-compact-inject.sh` to append core.md content.

**Test process:**
1. Back up: `cp ~/.claude/hooks/post-compact-inject.sh ~/.claude/hooks/post-compact-inject.sh.backup`
2. Apply the change
3. Start a new Claude session
4. Verify: Claude's context includes both CLAUDE.md and core.md content

**Rollback:** `cp ~/.claude/hooks/post-compact-inject.sh.backup ~/.claude/hooks/post-compact-inject.sh`

**Pass/fail criteria:**
- PASS: Claude mentions it can see core.md content in session context
- FAIL: Hook produces invalid JSON (check with `bash -x post-compact-inject.sh` first)

### Step 6: Test full Memory Sync cycle (integration test)

1. Ensure there are >30 unsummarized conversations (check: `node ~/zylos/zylos-core/skills/comm-bridge/scripts/c4-db.js unsummarized`)
2. Start a fresh Claude session
3. Verify: Claude receives Memory Sync trigger from c4-session-init.js
4. Invoke `/memory-sync --begin X --end Y`
5. Verify: memory files updated, git commit created, checkpoint created
6. Start another fresh session
7. Verify: new checkpoint summary shown, no Memory Sync trigger (conversations are now summarized)

**Pass/fail criteria:**
- PASS: After sync, `git log -1 --oneline` shows "Memory sync: conversations X-Y" (or similar)
- PASS: `node c4-db.js checkpoints` shows a new checkpoint with the summary
- PASS: Next session start shows the checkpoint summary, not a Memory Sync trigger
- FAIL: Memory files not updated, or checkpoint not created, or next session still triggers sync

---

## 8. Testing Strategy

### Unit Tests

| Test | Command | Expected |
|------|---------|----------|
| memory-commit.sh (no changes) | `bash memory-commit.sh` | Exit 0, no new commit |
| memory-commit.sh (with changes) | Edit a memory file, then `bash memory-commit.sh` | New git commit with "Memory auto-save" message |
| memory-commit.sh (git conflict) | Create `.git/MERGE_HEAD`, run script | Exit 0, no commit attempt, stderr message |
| rotate-session.js (no today.md) | Delete today.md, run script | Creates fresh today.md with today's date |
| rotate-session.js (same day) | Run twice on same day | Second run outputs "No rotation needed" |
| rotate-session.js (day change) | Set today.md header to yesterday's date, run | Renames to yesterday.md, creates fresh today.md |

### Integration Tests

| Test | Steps | Expected |
|------|-------|----------|
| **Hook chain** | Start new session | Claude sees CLAUDE.md + core.md + C4 context |
| **Threshold trigger** | Accumulate >30 conversations, send a message | Claude sees Memory Sync trigger |
| **Full sync cycle** | Run /memory-sync with valid range | Files updated, commit created, checkpoint created |
| **Session continuity** | Run sync, then restart session | New session shows checkpoint summary |
| **Crash recovery** | Kill Claude, let activity-monitor restart | Session starts with core.md + checkpoint summary |
| **Day rotation** | Wait for day boundary (or simulate) | today.md rotated, fresh one created |

### Manual Verification Checklist

After full deployment, verify these properties:

- [ ] `cat ~/zylos/memory/core.md` shows structured identity info under 3KB
- [ ] `cat ~/zylos/memory/reference/decisions.md` has timestamped entries
- [ ] `cat ~/zylos/memory/sessions/today.md` has timestamped session events
- [ ] `git log --oneline -5 -- memory/` shows recent auto-commits
- [ ] `node c4-db.js checkpoints` shows at least one checkpoint with a meaningful summary
- [ ] Starting a new Claude session shows core.md content + checkpoint summary
- [ ] After running Memory Sync, the conversation counter resets (threshold-check silent)

---

## 9. Phase 2 Preview (What KB Enables)

Phase 2 adds the Knowledge Base as a retrieval and metadata layer **on top of** the Phase 1 file system. Phase 1 is a prerequisite; Phase 2 is an optional upgrade.

### What Phase 2 Adds

| Inside Out Mechanism | Phase 1 (Files Only) | Phase 2 (Files + KB) |
|---------------------|---------------------|---------------------|
| Emotional Coloring | No metadata beyond timestamps | `memory_type`, `freshness`, `importance` columns |
| Recall Tubes | grep on files | FTS5 keyword search (faster, more robust) |
| Train of Thought | Manual index browsing | Embedding similarity search (associative retrieval) |
| Memory Fading | Git blame as rough proxy | Automated `last_accessed` + `access_count` decay |
| Abstract Thought | Raw files or nothing | KB entries as Level 2 summaries linking to raw files |

### Phase 2 Tasks (Preview, Not Detailed)

1. **KB schema migration:** Add `memory_type`, `freshness`, `source_file`, `last_accessed`, `access_count`, `related_entries` columns to KB entries table
2. **Memory Sync KB integration:** After writing to files, Memory Sync also creates/updates KB entries as summaries linking to the files via `source_file`
3. **KB fading task:** Weekly scheduled task computes freshness from `last_accessed` and flags aging/fading entries
4. **KB cross-referencing:** Consolidation task finds related entries and populates `related_entries` links
5. **Retrieval upgrade:** Update Memory Sync and session-init to use KB search for context-relevant memory surfacing

### Phase 2 Prerequisites

- Phase 1 fully deployed and running for at least a few days
- Memory file layout stable (no more structural changes)
- KB database backed up before schema migration
- OpenAI API access confirmed for embedding generation (or fallback to FTS5-only)

---

## 10. Review Revision Responses

The [proposal review](memory-inside-out-review.md) identified 5 required revisions. This implementation plan addresses each:

### Revision 1: Strengthen Variant A's retrieval story

**Response:** Phase 1 focuses on the Memory Sync pipeline (conversation -> structured files -> git). Retrieval in Phase 1 is intentionally simple:
- `core.md` is always loaded (no retrieval needed)
- `index.md` provides a table of contents (loaded on demand, ~1-2KB)
- `grep -r "keyword" ~/zylos/memory/` for targeted search
- Session logs are chronological and naturally browsable

**Scale ceiling acknowledged:** Phase 1's retrieval works well at the current scale (~5 reference files, ~50 session logs). Above ~200 files, grep becomes noisy and index.md becomes stale. This is an explicit reason to upgrade to Phase 2 (KB-backed retrieval).

**Index update frequency:** The Memory Sync skill updates `index.md` entry counts each time it runs (typically every ~30 conversations). This is more frequent than the original proposal's weekly-only update.

### Revision 2: Add explicit rollback plans and pass/fail criteria

**Response:** Section 7 (Migration Plan) now includes:
- Specific rollback command for each step
- Pass/fail criteria for each step
- Backup commands before modifying hooks
- Integration test sequence after full deployment

### Revision 3: Split consolidate.js into focused scripts

**Response:** Phase 1 does not implement a weekly consolidation task (that's Phase 2 scope). The scripts in Phase 1 are already focused and single-purpose:
- `memory-commit.sh` -- only does git add/commit
- `rotate-session.js` -- only handles session log rotation
- Memory Sync itself is a Claude skill (not a script), so "splitting" doesn't apply

When weekly consolidation is added (Phase 2), it will follow the review's recommendation: separate scripts for `rotate-sessions.js`, `archive-fading.js`, `update-index.js`, called by a thin orchestrator.

### Revision 4: CLAUDE.md slimming safety audit

**Response:** Phase 1 does NOT slim CLAUDE.md. The current 15KB CLAUDE.md stays as-is. The Inside Out proposal's "Personality Islands" mechanism (CLAUDE.md slimming) is deferred because:
1. It has the highest migration risk of any single change
2. It's independent of the Memory Sync pipeline
3. It should be done incrementally after Phase 1 is stable

If CLAUDE.md slimming is done later, the review's recommendation stands: move one section per session, verify behavior, keep Telegram/Lark rules in CLAUDE.md (unpredictable triggers), move Browser SOP to skill (explicitly requested tasks only).

### Revision 5: Acknowledge [AGING]/[FADING] markers add parsing complexity

**Response:** Phase 1 does NOT implement fading markers. Freshness tracking is deferred to Phase 2 (KB-based) because:
1. File-based markers require markdown parsing in consolidation scripts (fragile)
2. KB columns with SQL queries are far simpler and more reliable
3. At Phase 1 scale, staleness is visible by reading timestamps in file entries

Phase 1 includes timestamps on every entry (`### [YYYY-MM-DD] Decision Title`), which provides a rough staleness signal without automated fading.

---

## Appendix A: Dependency Map

```
No external dependencies for Phase 1.

C4 Scripts (EXISTING, no changes):
├── c4-fetch.js          -- Memory Sync calls this to read conversations
├── c4-checkpoint.js     -- Memory Sync calls this to mark sync boundary
├── c4-session-init.js   -- Hook triggers Memory Sync when threshold exceeded
└── c4-threshold-check.js -- Hook triggers Memory Sync mid-session

New Files (all in zylos-core repo):
├── skills/memory-sync/SKILL.md           -- Claude instructions
├── skills/memory-sync/package.json       -- ESM module
├── skills/memory-sync/scripts/memory-commit.sh  -- Git commit
├── skills/memory-sync/scripts/rotate-session.js -- Session rotation
└── skills/memory-sync/templates/*.md     -- File templates

Memory Files (in ~/zylos/memory/, git-tracked):
├── core.md              -- NEW: identity anchor
├── index.md             -- NEW: table of contents
├── reference/           -- NEW dir: migrated from memory/
│   ├── decisions.md
│   ├── projects.md
│   └── preferences.md
├── sessions/            -- NEW dir
│   └── today.md
└── archive/             -- NEW dir (empty initially)

Hook Changes (in ~/.claude/):
├── hooks/post-compact-inject.sh   -- Modified: add core.md injection
└── settings.local.json            -- Modified: add C4 hooks
```

## Appendix B: Estimated Implementation Order

| Order | Task | Effort | Risk | Depends On |
|-------|------|--------|------|-----------|
| 1 | Create directory structure | 5 min | None | - |
| 2 | Create templates (core.md, etc.) | 30 min | None | - |
| 3 | Build Memory Sync SKILL.md | 1-2 hours | Low | Templates |
| 4 | Build memory-commit.sh | 15 min | Low | - |
| 5 | Build rotate-session.js | 30 min | Low | - |
| 6 | Migrate existing memory files | 30 min | Low | Dirs exist |
| 7 | Create core.md from context.md | 30 min | Low | Template, migration |
| 8 | Update post-compact-inject.sh | 15 min | Medium | core.md exists |
| 9 | Update settings.local.json (hooks) | 15 min | Medium | C4 scripts working |
| 10 | Create index.md | 15 min | None | Migration complete |
| 11 | Integration test: hook chain | 30 min | - | Steps 8-9 |
| 12 | Integration test: full sync cycle | 1 hour | - | All above |
| 13 | Update memory/SKILL.md | 15 min | None | - |

**Total estimated effort: ~5-6 hours of implementation + testing**

## Appendix C: What This Plan Does NOT Cover

To keep Phase 1 focused and implementable, these items are explicitly out of scope:

1. **CLAUDE.md slimming** -- Deferred (high risk, independent of sync pipeline)
2. **KB integration** -- Deferred to Phase 2
3. **Automated fading/freshness** -- Deferred to Phase 2
4. **Weekly consolidation** -- Deferred to Phase 2
5. **Embedding-based retrieval** -- Deferred to Phase 2
6. **Stop hook** -- Not available in current Claude Code hook system
7. **building-ideas.md** -- Can be added to `reference/ideas.md` during migration if the file exists
8. **Learning document indexing** -- Phase 1 uses grep; Phase 2 uses KB
