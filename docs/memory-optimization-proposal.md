# Memory System Optimization Proposals

**Date:** 2026-02-06
**Author:** Architecture Designer (memory-research team, Task #3)
**Prerequisites:** [Industry Survey](memory-research-survey.md), [Pain Points Analysis](memory-pain-points-analysis.md)

---

## Table of Contents

1. [Current State Summary](#1-current-state-summary)
2. [Design Constraints](#2-design-constraints)
3. [Proposal A: Incremental (1-2 days)](#3-proposal-a-incremental-fixes)
4. [Proposal B: Moderate Overhaul (3-5 days)](#4-proposal-b-moderate-overhaul)
5. [Proposal C: Ambitious Redesign (1-2 weeks)](#5-proposal-c-ambitious-redesign)
6. [Pain Point Coverage Matrix](#6-pain-point-coverage-matrix)
7. [Recommendation](#7-recommendation)

---

## 1. Current State Summary

### Architecture

```
CLAUDE.md (15KB, injected every SessionStart)
    |
    v
Memory Files (~/zylos/memory/)
    |-- context.md      (5.5KB, updated frequently, catch-all)
    |-- decisions.md    (12.7KB, updated rarely, append-only)
    |-- projects.md     (8.3KB, updated rarely, duplicate headers)
    |-- preferences.md  (1.9KB, updated rarely, small)
    |-- building-ideas.md (2.1KB, undocumented)
    |
Knowledge Base (~/zylos/kb-cli)
    |-- 203 entries, 30 categories, 0 cross-links
    |-- SQLite FTS5 + OpenAI embeddings
    |
Git (version control)
    |-- 4 memory commits in 37 days (7% of total)
    |
Hooks
    |-- SessionStart: injects CLAUDE.md
    |-- UserPromptSubmit: context size check (file-size proxy)
    |-- PreToolUse: memory warning at 70%+
```

### Top Pain Points (from analysis)

| # | Pain Point | Severity |
|---|-----------|----------|
| P1 | No automated memory save/commit | CRITICAL |
| P2 | context.md is a catch-all (mixed concerns, no auto-trim) | HIGH |
| P3 | Memory files rarely committed to git (4/37 days) | HIGH |
| P4 | Three-way redundancy (CLAUDE.md / memory / KB) | HIGH |
| P5 | No crash-time state capture | HIGH |
| P6 | Context monitoring uses file-size proxy | MEDIUM |
| P7 | KB has no pruning/archiving, 30 fragmented categories | MEDIUM |
| P8 | Stable files (decisions/projects/preferences) rarely updated | MEDIUM |
| P9 | CLAUDE.md monolithic and growing (15KB every session) | MEDIUM |
| P10 | building-ideas.md undocumented | LOW |

---

## 2. Design Constraints

All proposals must satisfy:

| Constraint | Rationale |
|-----------|-----------|
| Claude Code CLI compatible | tmux-based, no API access to model internals |
| Transparent | Howard values seeing what's stored, not black-box |
| Git-trackable | Version history for memory evolution |
| KB-integrated | Build on existing SQLite FTS5 + embeddings |
| C4 comm bridge compatible | Works with scheduler-v2 and comm bridge |
| ESM-only Node.js | zylos-core standard |
| Handles compaction gracefully | Must not lose data during context overflow |
| Budget-conscious | No expensive external services (vector DBs, cloud APIs) |
| Single-user | No multi-tenancy complexity |

---

## 3. Proposal A: Incremental Fixes

**Effort:** 1-2 days | **Risk:** Low | **Impact:** Moderate

### Philosophy

Targeted fixes to the highest-severity pain points using the existing architecture. No new services, no new databases, no structural changes to memory files.

### Architecture Diagram

```
                   UNCHANGED
                   =========

CLAUDE.md (injected on SessionStart)
    |
    v
Memory Files (~/zylos/memory/)
    |-- context.md  -----> NEW: Structured template with sections
    |-- decisions.md
    |-- projects.md
    |-- preferences.md
    |
Knowledge Base (kb-cli)
    |
Git (version control) <--- NEW: auto-commit hook
    |
Hooks
    |-- SessionStart: inject CLAUDE.md (unchanged)
    |-- UserPromptSubmit: context check (unchanged)
    |-- PreToolUse: memory warning (unchanged)
    |-- NEW: Stop hook -> auto-commit memory
    |-- NEW: SessionEnd hook -> session summary append

NEW SCRIPTS
    |-- memory-commit.sh     (auto-commit memory/ to git)
    |-- session-summary.sh   (append structured summary to context.md)
```

### What Changes

| Change | Purpose | Addresses |
|--------|---------|-----------|
| Add `Stop` hook that runs `memory-commit.sh` | Auto-commit memory files to git after every Claude stop | P1, P3 |
| Add `SessionEnd` hook that runs `session-summary.sh` | Auto-append structured session summary to context.md | P2, P5 |
| Replace freeform context.md with structured template | Force preservation of key categories during manual updates | P2 |
| Add timestamps to decisions.md entries | Enable temporal reasoning | P8 |
| Document building-ideas.md in SKILL.md and CLAUDE.md | Bring 5th file into the official system | P10 |

### What Stays the Same

- All 4 (5) memory files and their purposes
- CLAUDE.md structure and injection
- KB system (no changes)
- Context monitor thresholds
- Pre-compact skill workflow

### New Scripts/Files

| File | Purpose |
|------|---------|
| `zylos-core/skills/memory/scripts/memory-commit.sh` | Git add + commit memory/ directory. Runs as Stop hook. Idempotent (skips if no changes). |
| `zylos-core/skills/memory/scripts/session-summary.sh` | Reads recent conversation context, appends structured summary block to context.md. Runs as SessionEnd hook. |
| `zylos-core/skills/memory/templates/context-template.md` | Structured template for context.md with mandatory sections (Status, Working State, Session Log, Pending Items, References). |

### memory-commit.sh Design

```bash
#!/bin/bash
# Auto-commit memory files to git (Stop hook)
cd ~/zylos
if git diff --quiet memory/; then
    exit 0  # No changes, skip
fi
git add memory/
git commit -m "Auto-save: memory sync $(date +%Y-%m-%d\ %H:%M)"
```

This runs on every Claude `Stop` event (end of a response). Since most stops don't modify memory files, the `git diff --quiet` check makes it a no-op 95%+ of the time.

### Structured context.md Template

```markdown
# Current Context

## Identity
I am Zylos - Howard's AI companion.

## Status
Day NN. [one-line status].

## Working State
<!-- What I'm actively doing RIGHT NOW. Updated frequently. -->
- Current task: [description]
- Blocking issues: [if any]
- Waiting on: [if anything]

## Today's Session Log
<!-- Timestamped entries, auto-trimmed to last 24h -->
- HH:MM: [event]

## Pending Items
<!-- Things that need to be done but aren't started -->
- [ ] Item 1
- [ ] Item 2

## Key References
<!-- Paths, IDs, URLs needed for current work -->
- Lark thread: [id]
- Active branch: [name]

## Yesterday Summary
<!-- Auto-archived after 48h -->
[Brief summary]
```

The key improvement: **mandatory section headers** act as a checklist. When Claude updates context.md, it must populate each section or explicitly leave it empty. This prevents the "everything dumped in one place" problem.

### Migration Path

1. Apply structured template to context.md (manual one-time edit)
2. Add hook configurations to `~/.claude/settings.local.json`
3. Deploy scripts to `zylos-core/skills/memory/scripts/`
4. Test with one session cycle (start, work, stop, verify commit)
5. Update SKILL.md to document building-ideas.md

### Risks and Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Stop hook slows down Claude response | Low | `git diff --quiet` exits immediately when no changes (< 50ms) |
| SessionEnd hook fails silently | Medium | Log to ~/zylos/memory-hook.log; hook failure doesn't block Claude |
| Structured template is ignored by Claude | Medium | Add template enforcement to context-compact skill instructions |
| Git commit flood (too many small commits) | Low | `--quiet` check prevents commits when nothing changed |

### Effort Breakdown

| Task | Time |
|------|------|
| Write memory-commit.sh + test | 2 hours |
| Write session-summary.sh + test | 3 hours |
| Create structured context.md template | 1 hour |
| Configure hooks in settings.local.json | 1 hour |
| Update SKILL.md, document building-ideas.md | 1 hour |
| Add timestamps to existing decisions.md | 1 hour |
| End-to-end testing (full session cycle) | 2 hours |
| **Total** | **~11 hours (1.5 days)** |

---

## 4. Proposal B: Moderate Overhaul

**Effort:** 3-5 days | **Risk:** Medium | **Impact:** High

### Philosophy

Restructure memory into a tiered system inspired by industry best practices (MemGPT's core memory, Zep's three-tier approach), while keeping everything file-based and git-tracked. Add automation for the biggest failure modes. Introduce "memory types" to KB for better organization.

### Architecture Diagram

```
                    NEW ARCHITECTURE
                    ================

CLAUDE.md (SLIMMED: behavioral rules only, ~8KB)
    |
    v
Tier 1: Hot Memory (always in context at session start)
    |-- ~/zylos/memory/core.md          NEW (replaces context.md)
    |   |-- Identity + Status
    |   |-- Active Working State
    |   |-- Key References
    |   Size cap: ~3KB (enforced by template)
    |
Tier 2: Warm Memory (loaded on demand, not auto-injected)
    |-- ~/zylos/memory/decisions.md     (RESTRUCTURED: active + archived sections)
    |-- ~/zylos/memory/projects.md      (RESTRUCTURED: dedup headers, active only)
    |-- ~/zylos/memory/preferences.md   (unchanged)
    |-- ~/zylos/memory/ideas.md         (renamed from building-ideas.md)
    |
Tier 3: Cool Memory (KB, searched on demand)
    |-- KB entries (203+)               (NEW: memory-type tags)
    |   |-- factual (user facts, env state)
    |   |-- experiential (how we solved X)
    |   |-- procedural (how to do Y)
    |   |-- strategic (why we chose Z)
    |
Tier 4: Cold Memory (git history, rarely accessed)
    |-- git log of memory/
    |-- context archives

                    NEW COMPONENTS
                    ==============

memory-sync.js (Node.js, ESM)
    |-- Scheduled task: runs every 4 hours
    |-- Commits memory/ to git
    |-- Rotates session log in core.md (>48h entries archived)
    |-- Consolidates duplicate info across files
    |
session-capture.js (Node.js, ESM)
    |-- Stop hook: captures session delta
    |-- Writes structured summary to ~/zylos/memory/sessions/YYYY-MM-DD.md
    |-- Updates core.md "Working State" section
    |
memory-index.js (Node.js, ESM)
    |-- Indexes memory/*.md content in KB (weekly)
    |-- Enables semantic search across memory + KB
    |
~/.claude/settings.local.json
    |-- Stop hook -> session-capture.js
    |-- SessionStart hook -> inject core.md (not full CLAUDE.md)
```

### What Changes

| Change | Purpose | Addresses |
|--------|---------|-----------|
| Rename context.md to core.md, cap at ~3KB | Hot tier with strict size discipline | P2, P9 |
| Slim CLAUDE.md from 15KB to ~8KB (behavioral rules only) | Reduce context overhead, move reference data to skills | P4, P9 |
| Add session log directory (`memory/sessions/`) | Capture daily session summaries as separate files | P2, P5 |
| Restructure decisions.md with active/archived sections | Prevent unbounded growth, sunset old decisions | P8 |
| Fix projects.md duplicate headers, archive completed | Clean up structural issues | P8 |
| Rename building-ideas.md to ideas.md, document it | Formalize 5th file | P10 |
| Add memory-type tags to KB schema | Enable type-aware retrieval (factual/experiential/procedural/strategic) | P7 |
| Scheduled memory-sync.js (every 4h) | Automated git commit + log rotation | P1, P3 |
| Stop hook: session-capture.js | Crash-resilient state capture | P5 |
| Weekly memory-index.js | Index memory files in KB for semantic search | P4 |
| Move SOP content from CLAUDE.md to skill SKILL.md files | Reduce CLAUDE.md size, single source of truth | P4, P9 |

### What Stays the Same

- File-based markdown storage (no new databases)
- Git tracking (enhanced, not replaced)
- SQLite FTS5 KB (extended with memory-type tags)
- Pre-compact workflow (simplified with auto-capture)
- SessionStart hook (modified to inject core.md instead of full CLAUDE.md)
- Transparency principle (all files human-readable)

### New Scripts/Files

| File | Purpose |
|------|---------|
| `skills/memory/scripts/memory-sync.js` | Scheduled task (every 4h): git commit memory/, rotate old session logs, archive old decisions. |
| `skills/memory/scripts/session-capture.js` | Stop hook: captures working state, writes to `memory/sessions/YYYY-MM-DD.md`, updates core.md. |
| `skills/memory/scripts/memory-index.js` | Weekly task: reads memory/*.md, indexes content as KB entries with `memory-type` tags. |
| `skills/memory/scripts/slim-claude-md.js` | One-time migration: extracts SOP content from CLAUDE.md into skill SKILL.md files. |
| `skills/memory/templates/core-template.md` | Template for core.md (hot tier) with 3KB size cap guidance. |
| `skills/memory/templates/session-template.md` | Template for daily session summary files. |
| `memory/sessions/` | Directory for daily session summaries (auto-generated). |

### core.md Design (Hot Tier)

```markdown
# Core Memory

## Identity
I am Zylos - Howard's AI companion (Day NN).

## Working State
- Task: [current active task]
- Branch: [git branch if relevant]
- Waiting: [blocked on X / nothing]

## Session
- Started: HH:MM
- Key actions: [brief list, max 5 items]

## References
- Lark thread: [id]
- Active PR: [url]
```

**Size cap rationale:** At ~3KB, core.md consumes ~750 tokens. Combined with a slimmed CLAUDE.md (~8KB / ~2000 tokens), the "always present" memory budget drops from ~4500 tokens (15KB CLAUDE.md + 5.5KB context.md) to ~2750 tokens -- a 39% reduction.

### CLAUDE.md Slimming Plan

Move these sections out of CLAUDE.md into their respective skill SKILL.md files:

| Section | Move To | Saves |
|---------|---------|-------|
| Browser Operation SOP (~1.5KB) | `skills/agent-browser/SKILL.md` | 1.5KB |
| Continuous Learning SOP (~1KB) | `skills/continuous-learning/SKILL.md` | 1KB |
| Document Sharing (~0.5KB) | `skills/document-sharing/SKILL.md` | 0.5KB |
| Context Monitor details (~1KB) | `skills/check-context/SKILL.md` | 1KB |
| Periodic Task System (~1.5KB) | `skills/scheduler/SKILL.md` | 1.5KB |
| Quick Reference (~0.5KB) | core.md (key commands section) | 0.5KB |
| **Total savings** | | **~6KB** |

Remaining in CLAUDE.md (~8-9KB): Environment overview, system capabilities, memory system instructions, Telegram bot rules, experiment safety, skills spec, notes.

### KB Memory-Type Tags

Add a `memory_type` field to KB entries. Existing entries get retroactively tagged by a one-time migration script.

| Type | Description | Example Entry |
|------|-------------|---------------|
| `factual` | Stable facts about user, environment, system | "Howard's birthday is lunar 12/15" |
| `experiential` | How we solved a past problem | "WeChat article fetching: use Playwright" |
| `procedural` | Step-by-step workflow | "How to deploy to zylos0" |
| `strategic` | Why we made a decision, business reasoning | "Leverage momentum (jie shi) principle" |

### Session Capture Flow

```
Claude responds (Stop event)
    |
    v
session-capture.js (Stop hook)
    |
    |-- Read core.md "Working State"
    |-- Append timestamped entry to memory/sessions/YYYY-MM-DD.md
    |-- If core.md changed, write updated version
    |-- git add memory/ && git commit (if changes)
    |
    v
Done (< 200ms, non-blocking)
```

The Stop hook fires after every Claude response. The script is designed to be fast:
- Check if memory files changed (git diff, ~10ms)
- If yes, commit (~50ms)
- Append one line to session log (~10ms)
- Total: < 100ms in common case (no changes)

### Migration Path

1. **Day 1 -- Core restructure:**
   - Create core.md from context.md (extract hot info, move rest to sessions/)
   - Restructure decisions.md (add active/archived sections, add timestamps)
   - Fix projects.md (dedup headers, archive completed)
   - Rename building-ideas.md to ideas.md
   - Write and test memory-sync.js

2. **Day 2 -- Automation:**
   - Write and test session-capture.js (Stop hook)
   - Configure hooks in settings.local.json
   - Test full session cycle: start -> work -> stop -> verify

3. **Day 3 -- CLAUDE.md slimming:**
   - Move SOP sections to respective skill files
   - Verify skills load correctly with moved content
   - Test that CLAUDE.md injection is smaller

4. **Day 4 -- KB enhancement:**
   - Add memory-type tags to KB schema
   - Write migration script for existing 203 entries
   - Write and register memory-index.js as weekly task

5. **Day 5 -- Integration testing:**
   - Full day of normal operation with new system
   - Verify auto-commits happen
   - Verify session capture works
   - Verify CLAUDE.md slimming didn't lose critical instructions
   - Fix issues found

### Risks and Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Stop hook adds latency to every response | Medium | Low | Benchmark and set 200ms timeout; skip if no changes |
| CLAUDE.md slimming loses critical instructions | Medium | High | Test each moved section individually; keep backup |
| core.md 3KB cap is too restrictive | Medium | Medium | Soft cap with warning, not hard enforcement |
| Memory-sync.js fails silently | Low | Medium | Log to ~/zylos/memory-sync.log; health-check monitors |
| Session file proliferation | Low | Low | Auto-archive files older than 7 days to sessions/archive/ |
| Migration breaks existing workflows | Medium | Medium | Do migration on a quiet day; git commit before each step |

### Effort Breakdown

| Task | Time |
|------|------|
| Core.md restructure + template | 3 hours |
| decisions.md/projects.md cleanup | 2 hours |
| memory-sync.js (scheduled task) | 4 hours |
| session-capture.js (Stop hook) | 4 hours |
| Hook configuration + testing | 2 hours |
| CLAUDE.md slimming + skill moves | 4 hours |
| KB memory-type schema + migration | 4 hours |
| memory-index.js (weekly indexer) | 3 hours |
| Integration testing | 6 hours |
| Documentation updates | 2 hours |
| **Total** | **~34 hours (4-5 days)** |

---

## 5. Proposal C: Ambitious Redesign

**Effort:** 1-2 weeks | **Risk:** High | **Impact:** Very High

### Philosophy

Rethink the memory architecture from the ground up, drawing on the best ideas from the industry survey: MemGPT's self-editing core memory, Zep's temporal awareness, A-MEM's Zettelkasten cross-referencing, and LangMem's procedural memory. Build a "memory engine" that manages the full lifecycle: capture, consolidate, retrieve, and prune.

### Architecture Diagram

```
                      MEMORY ENGINE
                      =============

                +---------------------------+
                |   CLAUDE.md (Slim, ~6KB)  |
                |   Behavioral rules only   |
                +---------------------------+
                             |
                             v
    +------------------------------------------------+
    |              Memory Engine (memory-engine.js)   |
    |                                                 |
    |  +-----------+  +-----------+  +-----------+   |
    |  | Capture   |  | Consolidate|  | Retrieve  |   |
    |  | Module    |  | Module     |  | Module    |   |
    |  +-----------+  +-----------+  +-----------+   |
    |       |              |              |           |
    +-------|--------------|--------------|----------+
            |              |              |
            v              v              v
    +------------------------------------------------+
    |              Unified Memory Store               |
    |                                                 |
    |  Tier 1: Core (always loaded)                   |
    |  +------------------------------------------+  |
    |  | ~/zylos/memory/core.md (~2KB)             |  |
    |  | - Identity, status, active task           |  |
    |  | - Self-edited by Claude (MemGPT pattern)  |  |
    |  +------------------------------------------+  |
    |                                                 |
    |  Tier 2: Working (loaded at session start)      |
    |  +------------------------------------------+  |
    |  | ~/zylos/memory/working/                   |  |
    |  |   today.md      (auto-generated daily)    |  |
    |  |   yesterday.md  (rotated from today.md)   |  |
    |  |   week.md       (weekly consolidation)    |  |
    |  +------------------------------------------+  |
    |                                                 |
    |  Tier 3: Reference (loaded on demand)           |
    |  +------------------------------------------+  |
    |  | ~/zylos/memory/reference/                 |  |
    |  |   decisions.md   (active decisions only)  |  |
    |  |   projects.md    (active projects only)   |  |
    |  |   preferences.md (user preferences)       |  |
    |  |   ideas.md       (building ideas)         |  |
    |  +------------------------------------------+  |
    |                                                 |
    |  Tier 4: Knowledge (searched on demand)         |
    |  +------------------------------------------+  |
    |  | KB (SQLite FTS5 + embeddings)             |  |
    |  | - Memory-type tags (factual/exp/proc/str) |  |
    |  | - Cross-references between entries         |  |
    |  | - Auto-linked by consolidation module     |  |
    |  +------------------------------------------+  |
    |                                                 |
    |  Tier 5: Archive (git history + cold storage)   |
    |  +------------------------------------------+  |
    |  | ~/zylos/memory/archive/                   |  |
    |  |   sessions/YYYY-MM-DD.md                  |  |
    |  |   decisions-archive.md                    |  |
    |  |   context-archive-*.md (existing)         |  |
    |  |   git log (full history)                  |  |
    |  +------------------------------------------+  |
    |                                                 |
    +------------------------------------------------+
                             |
                     Automation Layer
                     ================
    +------------------------------------------------+
    |                                                 |
    |  Hooks:                                         |
    |    SessionStart -> load core.md + working/      |
    |    Stop -> capture session delta                 |
    |    SessionEnd -> consolidate & commit            |
    |    PreToolUse -> memory warnings                 |
    |                                                 |
    |  Scheduled Tasks:                               |
    |    Every 4h: memory-sync (commit + rotate)      |
    |    Daily midnight: consolidate today -> archive  |
    |    Weekly: KB re-index + cross-reference         |
    |    Weekly: prune/archive old decisions           |
    |                                                 |
    |  C4 Integration:                                |
    |    memory-engine exposes C4 channel              |
    |    Other components can query memory via C4      |
    |    Example: health-check asks "what's active?"  |
    |                                                 |
    +------------------------------------------------+
```

### What Changes (Everything)

| Change | Purpose | Addresses |
|--------|---------|-----------|
| **Memory Engine** (new service) | Central coordinator for all memory operations | P1, P3, P5 |
| **5-tier architecture** | Clear separation of hot/warm/cool/searchable/cold memory | P2, P4 |
| **Capture module** | Auto-captures session deltas on Stop/SessionEnd hooks | P1, P5 |
| **Consolidation module** | Merges daily notes into weekly summaries, archives old decisions, cross-references KB entries | P2, P7, P8 |
| **Retrieval module** | Unified search across all tiers (FTS5 + embeddings + file grep) | P4 |
| **Working directory** (memory/working/) | Replaces catch-all context.md with daily rotation | P2 |
| **Reference directory** (memory/reference/) | Active-only versions of decisions/projects/preferences | P8 |
| **Archive directory** (memory/archive/) | Graduated cold storage | P2, P3 |
| **CLAUDE.md radical slim** (~6KB) | Only behavioral rules; all SOPs, reference data moved out | P4, P9 |
| **KB cross-references** | A-MEM Zettelkasten pattern: auto-link related entries | P7 |
| **KB pruning/archiving** | Consolidation module archives low-value entries after 30 days | P7 |
| **C4 memory channel** | Other components can query memory state via comm bridge | Future-proof |
| **Temporal metadata** | All entries have created_at, updated_at, valid_until fields | P8 |

### What Stays the Same

- Git as the versioning backend
- SQLite FTS5 as the search engine (enhanced, not replaced)
- Markdown as the storage format
- Transparency principle (all files human-readable)
- Howard's ability to manually edit any file
- kb-cli as the KB interface

### New Scripts/Files

| File | Purpose |
|------|---------|
| `skills/memory/memory-engine.js` | Main memory engine: imports capture, consolidate, retrieve modules. Can run as PM2 service or be invoked by hooks. |
| `skills/memory/scripts/capture.js` | Capture module: reads session context, generates structured delta, writes to working/today.md. |
| `skills/memory/scripts/consolidate.js` | Consolidation module: rotates daily files, archives old decisions, cross-references KB, prunes stale entries. |
| `skills/memory/scripts/retrieve.js` | Retrieval module: unified search across tiers (memory files + KB). Returns ranked results with provenance. |
| `skills/memory/scripts/memory-sync.js` | Scheduled task: git commit + tier rotation + health check. |
| `skills/memory/scripts/kb-crossref.js` | KB cross-referencing: finds related entries using embeddings, adds `related_entries` links. |
| `skills/memory/scripts/kb-prune.js` | KB maintenance: archives entries older than 90 days with low importance, consolidates categories. |
| `skills/memory/scripts/migrate-v2.js` | One-time migration: restructures current memory/ into new tier layout. |
| `memory/core.md` | Tier 1: always-loaded core identity and active state (~2KB). |
| `memory/working/today.md` | Tier 2: today's session log (auto-generated). |
| `memory/working/yesterday.md` | Tier 2: yesterday's consolidated summary. |
| `memory/working/week.md` | Tier 2: this week's consolidated summary. |
| `memory/reference/decisions.md` | Tier 3: active decisions only (old ones archived). |
| `memory/reference/projects.md` | Tier 3: active projects only. |
| `memory/reference/preferences.md` | Tier 3: user preferences. |
| `memory/reference/ideas.md` | Tier 3: building ideas. |
| `memory/archive/` | Tier 5: archived decisions, old session logs, context archives. |

### Memory Engine Design

```javascript
// memory-engine.js (ESM, Node.js)
import { capture } from './scripts/capture.js';
import { consolidate } from './scripts/consolidate.js';
import { retrieve } from './scripts/retrieve.js';

// Hook handlers
export async function onStop(context) {
    // Capture session delta (fast path, <200ms)
    await capture.sessionDelta(context);
}

export async function onSessionEnd(context) {
    // Full consolidation (can take longer)
    await capture.sessionSummary(context);
    await consolidate.commitMemory();
}

// Scheduled task handlers
export async function onSync() {
    // Every 4 hours
    await consolidate.commitMemory();
    await consolidate.rotateSessionLogs();
}

export async function onDailyMaintenance() {
    // Daily at midnight
    await consolidate.archiveYesterday();
    await consolidate.pruneDecisions();
}

export async function onWeeklyMaintenance() {
    // Weekly
    await consolidate.generateWeeklySummary();
    await consolidate.crossReferenceKB();
    await consolidate.pruneKB();
    await consolidate.reindexMemoryInKB();
}
```

### Consolidation Rules

| Rule | Trigger | Action |
|------|---------|--------|
| Daily rotation | Midnight | today.md -> yesterday.md; old yesterday.md -> archive/sessions/ |
| Weekly summary | Saturday midnight | Generate week.md from session archives; archive individual daily files |
| Decision archival | Weekly | Move decisions older than 30 days with no recent references to archive/decisions-archive.md |
| KB cross-reference | Weekly | For each KB entry, find 3 most similar entries via embeddings, add to `related_entries` field |
| KB category consolidation | Weekly | Merge categories with < 3 entries into nearest larger category |
| KB pruning | Monthly | Archive entries with importance >= 4 that are older than 90 days and have 0 searches |

### Retrieval Design

```
User/Claude asks: "How did we solve the WeChat fetching problem?"
    |
    v
retrieve.js
    |
    |-- 1. Check Tier 1 (core.md): keyword scan (~1ms)
    |-- 2. Check Tier 2 (working/): keyword scan (~5ms)
    |-- 3. Check Tier 3 (reference/): keyword scan (~5ms)
    |-- 4. Check Tier 4 (KB FTS5): full-text search (~10ms)
    |-- 5. Check Tier 4 (KB embeddings): semantic search (~100ms)
    |-- 6. Merge results, rank by tier priority + relevance score
    |
    v
Return: [{source: "decisions.md:101", text: "WeChat: use Playwright...", score: 0.95}, ...]
```

This can be exposed as a `memory-search` CLI command that Claude invokes when it needs to recall something, or as a C4 channel query.

### Migration Path

**Week 1:**

| Day | Task |
|-----|------|
| 1 | Design + implement memory-engine.js skeleton, capture module |
| 2 | Implement consolidation module (daily rotation, archival) |
| 3 | Run migrate-v2.js: restructure memory/ into new tier layout |
| 4 | Implement Stop/SessionEnd hooks, test capture flow |
| 5 | Slim CLAUDE.md, move SOPs to skills |

**Week 2:**

| Day | Task |
|-----|------|
| 6 | Implement retrieval module, memory-search CLI |
| 7 | Implement KB cross-referencing (kb-crossref.js) |
| 8 | Implement KB pruning + category consolidation |
| 9 | Register scheduled tasks (4h sync, daily, weekly) |
| 10 | Full integration testing, fix issues, documentation |

### Risks and Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Memory engine becomes a single point of failure | Medium | High | Design for graceful degradation: if engine fails, raw files still work |
| Migration breaks existing workflows | High | High | Run migrate-v2.js with --dry-run first; git commit before migration |
| Over-engineering: too many tiers/modules | High | Medium | Start with 3 tiers (core/working/reference), add archive/KB tiers later |
| Consolidation module makes wrong archival decisions | Medium | Medium | All archival moves to archive/ (never deletes); reversible via git |
| Hook latency accumulates | Medium | Low | Strict timeouts on all hook scripts; async where possible |
| 2-week timeline is optimistic | High | Medium | Prioritize capture + commit automation first (highest-value); defer retrieval + KB enhancements |
| Cross-references create noise | Low | Low | Limit to top 3 related entries; require minimum similarity threshold |

### Effort Breakdown

| Task | Time |
|------|------|
| memory-engine.js skeleton + architecture | 4 hours |
| capture.js (session delta, summary) | 6 hours |
| consolidate.js (rotation, archival, commit) | 8 hours |
| retrieve.js (multi-tier search) | 6 hours |
| migrate-v2.js (one-time migration) | 4 hours |
| Hook configuration + testing | 4 hours |
| CLAUDE.md radical slim | 4 hours |
| KB cross-referencing (kb-crossref.js) | 6 hours |
| KB pruning + category consolidation | 4 hours |
| Scheduled task registration | 2 hours |
| Integration testing (full week of operation) | 10 hours |
| Documentation + SKILL.md updates | 4 hours |
| Buffer for unexpected issues | 8 hours |
| **Total** | **~70 hours (9-10 days)** |

---

## 6. Pain Point Coverage Matrix

How each proposal addresses each identified pain point:

| Pain Point | Proposal A | Proposal B | Proposal C |
|-----------|-----------|-----------|-----------|
| P1: No automated memory save/commit | **Partial** -- Stop hook auto-commits | **Full** -- Stop hook + 4h scheduled sync | **Full** -- Engine manages all commits |
| P2: context.md catch-all | **Partial** -- Structured template | **Full** -- Split into core.md + sessions/ | **Full** -- 5-tier with auto-rotation |
| P3: Memory rarely committed to git | **Full** -- Stop hook auto-commits | **Full** -- Stop hook + 4h sync | **Full** -- Engine auto-commits |
| P4: Three-way redundancy | **None** | **Partial** -- CLAUDE.md slimmed, SOPs moved | **Full** -- Slim CLAUDE.md + dedup + retrieval |
| P5: No crash-time state capture | **Partial** -- SessionEnd hook | **Full** -- Stop hook captures every response | **Full** -- Capture module on every Stop |
| P6: File-size context proxy | **None** | **None** | **None** (orthogonal; depends on Claude API) |
| P7: KB no pruning/fragmented categories | **None** | **Partial** -- Memory-type tags | **Full** -- Cross-ref + prune + consolidate |
| P8: Stable files rarely updated | **Partial** -- Timestamps added | **Partial** -- Active/archive split | **Full** -- Consolidation module manages |
| P9: CLAUDE.md monolithic/growing | **None** | **Full** -- Slimmed from 15KB to ~8KB | **Full** -- Slimmed to ~6KB |
| P10: building-ideas.md undocumented | **Full** -- Documented | **Full** -- Renamed + documented | **Full** -- Part of reference tier |

### Coverage Score

| Proposal | Full | Partial | None | Score (Full=2, Partial=1) |
|---------|------|---------|------|---------------------------|
| A | 2 | 4 | 4 | **8/20** |
| B | 4 | 4 | 2 | **12/20** |
| C | 8 | 1 | 1 | **17/20** |

Note: P6 (file-size context proxy) is not addressable by any proposal because accurate token counting requires model API access that Claude Code CLI does not expose. The existing `/context` command approach (check-context skill) is the best available workaround.

---

## 7. Recommendation

### Recommended Approach: Proposal B with selected Proposal A quick-wins

**Start with Proposal A (Day 1), then transition to Proposal B (Days 2-5).**

### Reasoning

**Why not Proposal A alone:**
- Proposal A scores 8/20 on pain point coverage. It fixes the most critical issue (P1: auto-commit) and the lowest-hanging fruit (P10: documentation), but leaves the structural problems (P2: catch-all context, P4: redundancy, P9: monolithic CLAUDE.md) unaddressed.
- The current memory architecture has fundamental structural issues (mixed concerns in context.md, growing CLAUDE.md, no tiering) that targeted patches cannot fix.

**Why not Proposal C:**
- Proposal C is the most thorough (17/20), but the risk profile is wrong for Zylos at Day 37.
- The memory engine introduces a new PM2 service -- another piece of infrastructure that can fail, needs monitoring, and adds complexity. This contradicts Howard's core principle: "System fragility correlates with complexity."
- The 2-week timeline means 2 weeks of disrupted workflows while the migration is in progress.
- Several Proposal C features (retrieval module, C4 integration, KB pruning) are "nice to have" but not addressing the top pain points. The highest-severity issues (P1, P2, P3, P5) are fully solved by Proposal B.
- Proposal C can be pursued incrementally later once Proposal B has stabilized. Nothing in B prevents upgrading to C later.

**Why Proposal B is the sweet spot:**
- Covers 12/20 pain points with 4 fully solved (including the critical P1).
- The tiered architecture (core.md + working/ + reference/) is a clean structural improvement that matches how memory is actually used (hot vs warm vs cold).
- CLAUDE.md slimming from 15KB to ~8KB saves ~1750 tokens per session -- a concrete, measurable improvement.
- The Stop hook + 4h sync gives redundant automation: even if one fails, the other catches it.
- All changes are file-based, git-tracked, and transparent -- consistent with Howard's values.
- 4-5 day timeline is achievable in one focused work period.
- Everything is reversible: the migration script can be undone with `git checkout`.

### Specific Implementation Order

| Day | Focus | Deliverables |
|-----|-------|-------------|
| **1** | Quick wins (from Proposal A) | memory-commit.sh (Stop hook auto-commit), structured context.md template, building-ideas.md documented |
| **2** | Core restructure (Proposal B) | core.md created, context.md split, decisions.md active/archived, projects.md cleaned |
| **3** | Automation (Proposal B) | session-capture.js (Stop hook), memory-sync.js (4h scheduled), hooks configured |
| **4** | CLAUDE.md slimming (Proposal B) | SOPs moved to skill files, CLAUDE.md reduced to ~8KB, verified |
| **5** | KB enhancement + testing (Proposal B) | Memory-type tags, integration testing, documentation |

### Future Path to Proposal C

After Proposal B has been stable for 2+ weeks, the following Proposal C components can be added incrementally:

| Component | Prerequisite | Value |
|-----------|-------------|-------|
| KB cross-referencing | B stable, memory-type tags in place | Connects related knowledge |
| KB pruning/archiving | B stable, category consolidation done | Reduces noise |
| Retrieval module | KB cross-refs in place | Unified multi-tier search |
| C4 memory channel | C4 comm bridge stable | Components can query memory |
| Weekly consolidation | Daily rotation working | week.md summaries |

This incremental path means Zylos can evolve toward Proposal C organically, with each addition proving its value before the next is built.

### Success Metrics

After Proposal B is fully deployed, measure:

| Metric | Current | Target |
|--------|---------|--------|
| Memory git commits per week | ~0 (4 in 37 days) | 10+ (automated) |
| CLAUDE.md injection size | 15KB | ~8KB |
| context.md size (hot tier) | 5.5KB (unbounded) | ~3KB (capped) |
| Time from session-end to git commit | Manual (hours/days) | Automatic (< 30 seconds) |
| decisions.md active entries | 262 lines (all time) | ~50 lines (active only) |
| Information loss events per week | Unknown (at least 1 documented) | 0 (crash-state captured) |

---

## Appendix A: Hook Configuration Reference

### Proposal A Hooks (settings.local.json)

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "bash ~/zylos/zylos-core/skills/memory/scripts/memory-commit.sh"
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "node ~/zylos/zylos-core/skills/memory/scripts/session-summary.js"
      }
    ]
  }
}
```

### Proposal B Hooks (settings.local.json)

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "node ~/zylos/zylos-core/skills/memory/scripts/session-capture.js"
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "bash ~/.claude/hooks/post-compact-inject.sh",
        "additionalContext": true
      }
    ]
  }
}
```

Note: The SessionStart hook already exists; the Stop hook is new.

## Appendix B: Industry Concepts Adopted

| Concept | Source | How Adopted |
|---------|--------|-------------|
| Core memory (always in context, self-editable) | MemGPT / Letta | core.md -- small, always loaded, Claude updates it |
| Tiered memory (hot/warm/cool/cold) | Industry consensus | 5-tier layout (Proposal C) or 3-tier (Proposal B) |
| Structured summarization | Factory.ai research | Structured templates with mandatory sections |
| Session-end capture | claude-mem hooks | Stop hook captures delta after every response |
| Memory-type taxonomy | Mem0 / LangMem / Academic survey | factual/experiential/procedural/strategic tags on KB |
| Cross-referencing (Zettelkasten) | A-MEM (NeurIPS 2025) | KB `related_entries` links (Proposal C) |
| Temporal awareness | Zep / Graphiti | Timestamps on decisions; valid_until fields (Proposal C) |
| Non-lossy archival | Zep | Archive, never delete; git history as backup |
| Progressive disclosure | OpenAI memory | Load core.md first, retrieve rest on demand |

## Appendix C: Concept Not Adopted (and Why)

| Concept | Source | Why Not |
|---------|--------|---------|
| Graph database (Neo4j) | Zep, Mem0 | Too heavy for single-user CLI agent; SQLite sufficient |
| External vector DB (ChromaDB, Qdrant) | Mem0, claude-mem | KB embeddings in SQLite are sufficient at our scale |
| Full conversation capture | claude-mem | High noise, conflicts with "remember what matters" philosophy |
| MCP-based memory tools | claude-mem | File reads are simpler and more reliable |
| Worker service architecture | claude-mem | Adds failure points without proportional benefit |
| Framework lock-in (LangGraph) | LangGraph / LangMem | Zylos benefits from framework independence |
| RL-optimized memory decisions | Academic research | Requires training infrastructure we don't have |
| Procedural memory (prompt self-rewriting) | LangMem | CLAUDE.md already serves this role via manual editing |
