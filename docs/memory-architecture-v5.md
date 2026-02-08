# Memory Architecture v5 -- Complete Design

**Date:** 2026-02-08
**Author:** Architecture Agent (v5)
**Based on:** v4 design + Howard's 3 corrections (skill invocation, self-contained flush, threshold-check removal)
**Target:** zylos-core (open-source framework)

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Core.md Split -- Inside Out Model](#2-coremd-split----inside-out-model)
3. [Multi-User Design](#3-multi-user-design)
4. [Memory File Layout](#4-memory-file-layout)
5. [File Definitions and Classification Rules](#5-file-definitions-and-classification-rules)
6. [Memory Lifecycle (Inside Out Inspired)](#6-memory-lifecycle-inside-out-inspired)
7. [Tiered Loading Strategy](#7-tiered-loading-strategy)
8. [Template Files](#8-template-files)
9. [Skill Design (skills/zylos-memory/)](#9-skill-design-skillszylos-memory)
10. [templates/CLAUDE.md Memory Section](#10-templatesclaude-md-memory-section)
11. [Session Start Context Injection](#11-session-start-context-injection)
12. [Session Management (with Timezone)](#12-session-management-with-timezone)
13. [Unified Memory Sync Workflow](#13-unified-memory-sync-workflow)
14. [C4 Integration](#14-c4-integration)
15. [Memory Persistence Strategy](#15-memory-persistence-strategy)
16. [Scheduled Tasks via Scheduler](#16-scheduled-tasks-via-scheduler)
17. [Priority Model](#17-priority-model)
18. [Retrieval Strategy](#18-retrieval-strategy)
19. [Data Flow Diagrams](#19-data-flow-diagrams)
20. [Phase 2: KB Integration](#20-phase-2-kb-integration)
21. [Implementation Checklist](#21-implementation-checklist)
22. [Appendix A: Key Differences from v4](#appendix-a-key-differences-from-v4)
23. [Appendix B: Migration Guide](#appendix-b-migration-guide)
24. [Appendix C: .env Configuration](#appendix-c-env-configuration)
25. [Appendix D: Inside Out Mechanisms Not Adopted](#appendix-d-inside-out-mechanisms-not-adopted)
26. [Appendix E: reference/ Classification Decision Tree](#appendix-e-reference-classification-decision-tree)

---

## 1. Design Principles

### 1.1 Howard's 3 Corrections Applied (v4 -> v5)

| # | Correction | How v5 Responds |
|---|-----------|-----------------|
| 1 | **Skill invocation clarification** | `/zylos-memory` is Claude Code's skill invocation syntax. The skill runs as a **forked background subagent** (`context: fork`) with its own isolated context window. It does NOT block the main agent. Individual scripts (rotate-session.js, memory-sync.js, etc.) are helper scripts called BY the skill, not invoked directly. See Section 9. |
| 2 | **Remove --begin/--end external arguments** | The skill takes NO arguments. When invoked, `memory-sync.js` internally calls C4's `getUnsummarizedRange()` to determine what needs processing. The skill is fully self-contained. See Section 9 and 13. |
| 3 | **Remove c4-threshold-check hook** | `c4-threshold-check.js` is removed entirely. No more per-message threshold checking. Only two trigger paths remain: (A) session-init detects >30 unsummarized, (B) scheduled context check detects >=70% usage. Both instruct Claude to invoke `/zylos-memory`. See Section 11 and 14. |

### 1.2 v4 Corrections Carried Forward

| # | Correction | Status in v5 |
|---|-----------|-------------|
| 1 | **reference/ directory classification** | Unchanged from v4 |
| 2 | **references.md linking to config files** | Unchanged from v4 |
| 3 | **Bot's core digital assets** | Unchanged from v4 |
| 4 | **memory-init.js is unnecessary** | Unchanged from v4 |
| 5 | **Pre-compaction mechanism redesign** | Further simplified in v5 (no arguments, self-contained) |
| 6 | **Daily git commit for memory** | Unchanged from v4 |

### 1.3 Core Principles (v5)

1. **Memory integrity above conversation speed.** The agent must maintain its own memory health before serving user requests.

2. **Files on disk, daily git safety net.** Memory files are living documents on the filesystem. A daily local git commit provides version history and crash recovery.

3. **Node.js ESM only.** Every script in the memory system is a Node.js ESM module. No bash scripts, no shell wrappers, no CommonJS.

4. **Scheduler is the clock.** Any operation that needs to happen on a schedule is registered as a scheduler task. The memory skill itself has no timers.

5. **Tiered loading with Inside Out mapping.** Not all memory needs to be in context at all times. Identity is always loaded. User profiles are loaded when addressing that user. Working state is always loaded. Reference files are loaded on demand.

6. **Claude does the thinking.** The memory sync process relies on Claude's reasoning to extract, classify, and prioritize information from conversations. Scripts handle I/O; Claude handles intelligence.

7. **Bot identity is separate from user data.** The bot has a soul (identity.md) and its own digital assets. Users have profiles. These are independent concerns.

8. **Retrieval is intentional, not reflexive.** Memory search does not fire on every incoming message. It fires at specific architectural moments.

9. **References point, not duplicate.** Configuration values live in `.env` and config files. `references.md` links to them rather than copying values that will drift.

10. **One sync workflow, zero arguments.** The `/zylos-memory` skill is self-contained. It determines what needs processing internally (via C4's `getUnsummarizedRange()`), processes conversations, saves state, and creates checkpoints -- all without external arguments.

11. **Non-blocking subagent execution.** The memory skill runs as a forked subagent with its own isolated context window. The main agent continues working while memory sync runs in the background.

---

## 2. Core.md Split -- Inside Out Model

### 2.1 The Split

v3 split the original `core.md` into four focused files. v5 retains this split:

| File | Inside Out Analogy | Purpose | Loading | Size Guideline |
|------|-------------------|---------|---------|---------------|
| `identity.md` | Core Memory Tray | Who the bot is: name, personality, principles, digital assets | Always (session start) | ~1.5KB |
| `users/<id>/profile.md` | Personality Islands (per-person) | Per-user preferences, communication style, history | When addressing that user | ~1KB per user |
| `state.md` | Day's Memory Orbs on HQ floor | Active working state, current tasks, pending items | Always (session start) | ~2KB |
| `references.md` | Map on the wall | Pointers to config files, key paths, service discovery | Always (session start) | ~1KB |

**Total always-loaded budget: ~4.5KB** (identity + state + references). Each file can be updated independently.

### 2.2 Inside Out Mapping

```
INSIDE OUT                              ZYLOS v5
==========                              ========

Headquarters (Context Window)           Claude Code active session
  |-- Console                           Claude's reasoning loop
  |-- Core Memory Tray                  identity.md (SOUL + ASSETS)
  |-- Screen                            Current user request
  |-- Day's Orbs                        state.md (active work)

Personality Islands                     Skills + CLAUDE.md sections
  |-- Powered by core memories          Each skill references identity.md principles

Long-Term Memory Shelves                reference/ files + sessions/ + archive/
  |-- Organized by category             decisions.md, projects.md, preferences.md, ideas.md

Dream Production                        Scheduled idle-time tasks
  |-- Nightly flush                     Session rotation (daily)
  |-- Pattern synthesis                 Consolidation (weekly)

Memory Fading                           Freshness tracking in entries
  |-- Color loss over time              Timestamps enable staleness detection
  |-- Freshness states                  active -> aging -> fading -> archived

Recall Tubes                            grep/Read on memory files
Train of Thought                        Cross-references, index files
  |-- (Phase 2: FTS5/vector search)     KB extensibility points
```

### 2.3 identity.md -- The Soul + Digital Assets

**Purpose:** Contains who the bot is, independent of any user or working state. Also holds the bot's own digital assets (IDs, accounts, wallet references). This answers: "If you woke up with no memory of what you were doing, who are you and what do you own?"

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
- Configured TZ: see .env TZ

## Digital Assets
Bot-owned identity and account references. Sensitive values (API keys,
private keys) are stored in .env, not here -- this file only contains
references and non-sensitive identifiers.

### Accounts
- Email: [bot email, if any]
- GitHub: [bot GitHub username, if any]

### Wallet References
- [Wallet type]: address [public address only; private key in .env]

### API Key References
- [Service name]: key stored in .env as [ENV_VAR_NAME]

### Platform IDs
- [Platform]: [ID]
```

**Update frequency:** Rarely. Only when the bot's fundamental identity or asset inventory changes.

**Security note:** `identity.md` is loaded into every session's context. It must NEVER contain secrets, private keys, or API key values. Only references (e.g., "key stored in .env as OPENAI_API_KEY") are permitted. The actual sensitive values live in `.env`, which is never loaded into context.

### 2.4 state.md -- Active Working State

**Purpose:** What the bot is currently doing. The most frequently updated file. Answers: "What was I working on before this session started?"

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

### 2.5 references.md -- Pointers to Configuration

**Purpose:** A lookup table that **points to** configuration sources rather than duplicating their values. This prevents drift between references.md and the actual config files.

**Structure:**

```markdown
# References

## Configuration Sources
- Environment: ~/zylos/.env (TZ, DOMAIN, PROXY, API keys)
- Component registry: ~/.zylos/registry.json
- Component list: ~/.zylos/components.json
- Config constants: cli/lib/config.js

## Key Paths
- Memory: ~/zylos/memory/
- Skills: ~/zylos/.claude/skills/
- Logs: ~/zylos/logs/

## Services
- [Service 1]: [endpoint/port] (see .env for credentials)
- [Service 2]: [endpoint/port]

## Active IDs
- [Only IDs needed for current work context]

## Notes
- For TZ, domain, proxy: see .env
- For component versions: see ~/.zylos/registry.json
- This file is a pointer/index. Do NOT duplicate config values here.
```

**Design rule:** references.md must never duplicate a value that exists in `.env` or another config file. Instead, it points to the source. For example:
- Instead of `TZ: Asia/Shanghai`, write `TZ: see .env`
- Instead of `PROXY: http://192.168.3.9:7890`, write `Proxy: see .env PROXY`
- Instead of listing all API keys, write `API keys: see .env (OPENAI_API_KEY, etc.)`

**Update frequency:** When services or paths change. Not every sync cycle.

---

## 3. Multi-User Design

### 3.1 Architecture

The bot serves a team, not a single user. User-specific data is stored per-user:

```
~/zylos/memory/
├── identity.md                    # Bot's own soul + digital assets
├── state.md                       # Bot's working state
├── references.md                  # Pointers to config files
├── users/
│   ├── howard/
│   │   └── profile.md             # Howard's preferences, communication style
│   ├── teammate-a/
│   │   └── profile.md
│   └── ...
├── reference/
│   └── ...
├── sessions/
│   └── ...
└── archive/
    └── ...
```

### 3.2 User Profile (users/<id>/profile.md)

Each user has a profile file:

```markdown
# User Profile: [Display Name]

## Identity
- Name: [full name]
- User ID: [the identifier used in message routing]
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

**Loaded:** On demand, when the bot receives a message from this user or needs their preferences.

### 3.3 Bot Identity vs User Data

| Concern | File | Changes When |
|---------|------|-------------|
| Bot personality | `identity.md` | Bot's principles or style are redefined |
| Bot digital assets | `identity.md` (Digital Assets section) | New accounts, wallets, or API key references |
| Bot working state | `state.md` | Work focus changes |
| System configuration | `references.md` (pointers to .env etc.) | Services or paths change |
| User preferences | `users/<id>/profile.md` | User states a preference |
| Shared decisions | `reference/decisions.md` | Team makes a decision |
| Shared projects | `reference/projects.md` | Project status changes |
| Team preferences | `reference/preferences.md` | A preference applies across all users |
| Future plans | `reference/ideas.md` | New idea or plan recorded |

---

## 4. Memory File Layout

### 4.1 Directory Structure

```
~/zylos/memory/
├── identity.md              # Bot's soul + digital assets (ALWAYS loaded)
├── state.md                 # Active working state (ALWAYS loaded)
├── references.md            # Pointers to config files (ALWAYS loaded)
├── users/
│   ├── howard/
│   │   └── profile.md       # Per-user profile
│   └── .../
├── reference/
│   ├── decisions.md         # Key decisions and rationale
│   ├── projects.md          # Active/planned/completed projects
│   ├── preferences.md       # Shared team preferences (non-user-specific)
│   └── ideas.md             # Building ideas, future plans, explorations
├── sessions/
│   ├── current.md           # Today's session log (append-only)
│   └── YYYY-MM-DD.md        # Archived daily session logs
└── archive/                 # Cold storage for rotated/sunset items
    └── (files moved here by consolidation)
```

---

## 5. File Definitions and Classification Rules

### 5.1 reference/ Directory -- Clear Definitions

Each file in `reference/` serves a distinct purpose. They are **mutually exclusive** -- every piece of information belongs in exactly one file.

#### decisions.md -- What We Decided

**Definition:** Records of deliberate choices that constrain future behavior. A decision has a clear moment of commitment ("we decided to...") and closes off alternatives.

**Entry format:**
```markdown
### [Decision Title]
- **Date:** YYYY-MM-DD
- **Decided by:** [who]
- **Decision:** [what was decided]
- **Context:** [why this was decided, alternatives considered]
- **Status:** active | superseded | archived
- **Importance:** 1-5 (1=critical, 5=minor)
- **Type:** strategic | procedural
```

**Examples:**
- "Use ESM-only for all zylos-core code" (procedural)
- "Neutral stance on git for memory persistence" -> superseded by "Daily local git commit" (strategic)
- "KB is a retrieval index, not primary storage" (strategic)

**NOT decisions:** User preferences (-> preferences.md), project status updates (-> projects.md), ideas not yet committed to (-> ideas.md).

#### projects.md -- What We're Building

**Definition:** Records of work efforts with a defined scope and lifecycle. A project has a beginning, active work, and eventual completion or abandonment.

**Entry format:**
```markdown
### [Project Name]
- **Status:** planning | active | paused | completed | abandoned
- **Started:** YYYY-MM-DD
- **Updated:** YYYY-MM-DD
- **Description:** [what this project is]
- **Importance:** 1-5
- **Type:** factual
```

**Examples:**
- "Memory Architecture v5" (active)
- "Telegram Bot Security Audit" (completed)
- "Lark Integration" (active)

**NOT projects:** One-off tasks (-> state.md), decisions about how to build (-> decisions.md), wishes for future projects (-> ideas.md).

#### preferences.md -- How We Like Things Done

**Definition:** Shared preferences that apply across all users and across the bot's operation. These are standing instructions that don't have a decision moment -- they are observed patterns or stated preferences.

**Entry format:**
```markdown
### [Preference]
- **Date observed:** YYYY-MM-DD
- **Applies to:** all | [specific context]
- **Importance:** 1-5
- **Type:** procedural | experiential
```

**Examples:**
- "No emojis in code output"
- "Plain text only for Telegram messages"
- "Concise responses preferred over verbose"
- "Always reply to Telegram messages, even if just acknowledging"

**NOT preferences:** Per-user preferences (-> users/<id>/profile.md), decisions with alternatives considered (-> decisions.md), workflow ideas (-> ideas.md).

**Per-user vs shared:** If a preference is specific to one user (e.g., "Howard prefers English for technical discussions"), it goes in that user's `profile.md`. If it applies to all interactions regardless of user (e.g., "No emojis"), it goes in `preferences.md`.

#### ideas.md -- What We Might Do

**Definition:** Uncommitted plans, explorations, hypotheses, and building ideas. An idea becomes a project when work begins, or a decision when commitment is made.

**Entry format:**
```markdown
### [Idea Title]
- **Date:** YYYY-MM-DD
- **Source:** [who suggested it, or where it came from]
- **Status:** raw | exploring | ready-to-commit | dropped
- **Importance:** 1-5
- **Type:** strategic | experiential
- **Description:** [what the idea is]
- **Related:** [links to relevant decisions, projects, or other ideas]
```

**Examples:**
- "Vector search for memory retrieval" (exploring)
- "Browser-based dashboard for memory health" (raw)
- "Use Inside Out 2's Belief Strings for identity evolution" (raw)

**NOT ideas:** Things we've decided to do (-> decisions.md), things we're actively building (-> projects.md), configuration or reference data (-> references.md).

### 5.2 Entry Metadata -- Inside Out Emotional Coloring

Every entry in `reference/` files carries metadata inspired by Inside Out's emotional coloring:

| Field | Values | Purpose |
|-------|--------|---------|
| **Importance** | 1-5 (1=critical, 5=minor) | Priority for retention during archival |
| **Type** | factual, experiential, procedural, strategic | How the information is used |
| **Status** | active, superseded, archived (decisions); planning/active/paused/completed/abandoned (projects); raw/exploring/ready-to-commit/dropped (ideas) | Lifecycle state |
| **Date** | YYYY-MM-DD | When created or last updated |

**Type definitions:**
- **factual:** Objective, verifiable information (configurations, IDs, dates)
- **experiential:** Lessons learned from doing something ("last time we tried X, Y happened")
- **procedural:** Step-by-step how-to knowledge ("to deploy, do A then B then C")
- **strategic:** Why-level reasoning ("we chose X because of Y trade-off")

### 5.3 Classification Decision Tree

When Claude encounters new information during memory sync, use this decision tree:

```
Is this about the bot's identity, personality, or owned assets?
  YES -> identity.md
  NO  |
      v
Is this about a specific user's preference or communication style?
  YES -> users/<id>/profile.md
  NO  |
      v
Is this a system path, service endpoint, or config reference?
  YES -> references.md
  NO  |
      v
Is this a deliberate choice that closes off alternatives?
  YES -> reference/decisions.md
  NO  |
      v
Is this an active work effort with defined scope?
  YES -> reference/projects.md
  NO  |
      v
Is this a standing preference about how things should be done?
  YES -> Is it user-specific?
         YES -> users/<id>/profile.md
         NO  -> reference/preferences.md
  NO  |
      v
Is this an uncommitted idea, plan, or exploration?
  YES -> reference/ideas.md
  NO  |
      v
Is this a notable event worth logging?
  YES -> sessions/current.md
  NO  -> Probably not worth storing.
```

---

## 6. Memory Lifecycle (Inside Out Inspired)

### 6.1 The Eight Processes

v5 implements all eight Inside Out memory processes:

| # | Process | Inside Out | v5 Implementation |
|---|---------|-----------|-------------------|
| 1 | **Formation** | Emotions color new orbs | Memory sync extracts and classifies entries with metadata (importance, type) |
| 2 | **Protection** | Core memories in protected tray | identity.md always loaded; daily git commit provides version history |
| 3 | **Consolidation** | Nightly flush to long-term | Session rotation (daily), consolidation (weekly) |
| 4 | **Maintenance** | Dream Production | Idle-time scheduled tasks |
| 5 | **Retrieval** | Recall tubes + Train of Thought | grep/Read (Phase 1); FTS5 + vector (Phase 2) |
| 6 | **Fading** | Color loss over time | Freshness tracking: active -> aging -> fading -> archived |
| 7 | **Forgetting** | Memory Dump | Archive directory + git history (non-destructive) |
| 8 | **Abstraction** | Abstract Thought corridor | Raw files -> reference entries -> session summaries -> metadata |

### 6.2 Freshness Lifecycle

Entries in `reference/` files track freshness through timestamps:

```
active  (< 7 days since last update)
  --> aging   (7-30 days)
    --> fading  (30-90 days)
      --> archived (> 90 days, moved to archive/)
```

The weekly consolidation task reports on freshness states. Claude reviews the report and takes action (update, archive, or confirm still relevant).

**Immunity:** Entries with importance 1-2 are immune to automatic fading suggestions. They remain active regardless of last-update date.

---

## 7. Tiered Loading Strategy

| File | When Loaded | How |
|------|------------|-----|
| `identity.md` | Every session start, every post-compaction | SessionStart hook injects content |
| `state.md` | Every session start, every post-compaction | SessionStart hook injects content |
| `references.md` | Every session start, every post-compaction | SessionStart hook injects content |
| `users/<id>/profile.md` | On demand, when addressing that user | Read tool |
| `reference/*.md` | During memory sync, when Claude needs context | Claude reads via Read tool |
| `sessions/current.md` | During memory sync | Claude reads via Read tool |
| `sessions/YYYY-MM-DD.md` | Rarely, for historical lookup | Claude reads via Read tool |
| `archive/*` | Almost never | Claude uses Grep to search |

---

## 8. Template Files

### 8.1 Directory Structure in Repository

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
│   ├── preferences.md
│   └── ideas.md
├── sessions/
│   └── .gitkeep
└── archive/
    └── .gitkeep
```

### 8.2 Template Contents

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
- Configured TZ: see .env

## Digital Assets
Bot-owned accounts and identifiers. Sensitive values stored in .env.

### Accounts
(None configured yet)

### API Key References
(None configured yet -- add as services are set up)

### Platform IDs
(None configured yet)
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

## Configuration Sources
- Environment: ~/zylos/.env (TZ, DOMAIN, PROXY, API keys)
- Component registry: ~/.zylos/registry.json
- Config constants: cli/lib/config.js

## Key Paths
- Memory: ~/zylos/memory/
- Skills: ~/zylos/.claude/skills/

## Services
(Will be populated after setup)

## Active IDs
None yet.

## Notes
- For TZ, domain, proxy: see .env
- This file is a pointer/index. Do NOT duplicate config values here.
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

Format: Each entry has date, title, decision, context, status, importance, type.

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

#### templates/memory/reference/ideas.md

```markdown
# Ideas

Uncommitted plans, explorations, and building ideas.
An idea becomes a project when work begins, or a decision when commitment is made.

(No ideas yet.)
```

### 8.3 Installation

The `zylos init` CLI command copies `templates/memory/*` to `~/zylos/memory/`, creating all subdirectories. This is handled by the CLI installer -- the memory skill does NOT duplicate this initialization.

---

## 9. Skill Design (skills/zylos-memory/)

### 9.1 Naming and Invocation

The skill is named `zylos-memory`. Directory: `skills/zylos-memory/`.

**Invocation:** `/zylos-memory` (Claude Code's built-in skill invocation syntax)

When you type `/zylos-memory` in Claude Code, it invokes the skill defined in `skills/zylos-memory/SKILL.md`. This is **not** the same as manually running `node scripts/xxx.js`.

**Key architectural property:** The skill has `context: fork` in its SKILL.md frontmatter. This means it runs as a **forked background subagent** with its own isolated context window. The main Claude agent can continue working while the memory skill runs in the background. This is critical because:

- Memory sync can process large batches of conversations without consuming the main agent's context
- The main agent is never blocked waiting for memory sync to complete
- The subagent has full access to tools (Read, Edit, Write, Bash, Grep, Glob) within its own context

**Individual scripts** (rotate-session.js, memory-sync.js, daily-commit.js, etc.) are helper scripts called BY the skill's workflow inside the forked subagent. They are not intended to be invoked directly by the main agent.

### 9.2 File Structure

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
    └── daily-commit.js         # Daily local git commit of memory/ directory
```

**Not in v5 skill (removed from earlier versions):**
- `memory-init.js` -- Redundant with `zylos init` CLI command
- `pre-compaction-flush.js` -- Logic integrated into the unified sync workflow (Section 13)

### 9.3 SKILL.md

```yaml
---
name: zylos-memory
description: >-
  Core memory system. Maintains persistent memory across sessions via tiered
  markdown files following the Inside Out model. Handles Memory Sync (processing
  conversations into structured memory), session rotation, consolidation, and
  context-aware state saving. Runs as a forked subagent -- does NOT block the
  main agent. Invoke with /zylos-memory (no arguments needed).
context: fork
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Memory System

Maintains persistent memory across sessions via tiered markdown files.
This skill runs as a **forked subagent** with its own isolated context window.

## Architecture

```
~/zylos/memory/
├── identity.md              # Bot soul + digital assets (always loaded)
├── state.md                 # Active working state (always loaded)
├── references.md            # Pointers to config files (always loaded)
├── users/
│   └── <id>/profile.md     # Per-user preferences
├── reference/
│   ├── decisions.md         # Key decisions with rationale
│   ├── projects.md          # Active/planned projects
│   ├── preferences.md       # Shared team preferences
│   └── ideas.md             # Uncommitted plans and ideas
├── sessions/
│   ├── current.md           # Today's session log
│   └── YYYY-MM-DD.md        # Past session logs
└── archive/                 # Cold storage
```

## Memory Sync

### PRIORITY: Memory Sync is the HIGHEST priority task.

When hooks or the scheduler trigger a Memory Sync, you MUST process it
before responding to any pending user messages.

### When Triggered

Memory Sync is triggered in two ways:

1. **Session-init hook** -- At session start, if >30 unsummarized conversations,
   c4-session-init.js outputs an instruction for the main agent to invoke `/zylos-memory`
2. **Scheduled context check** -- Every 30 min, if context >=70%, the main agent
   invokes `/zylos-memory` to save state before potential compaction

Both result in this skill being invoked via `/zylos-memory` with NO arguments.

### Sync Flow (Step by Step)

**Step 1: Rotate session log if needed**

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js
```

**Step 2: Check for unsummarized conversations and fetch if needed**

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/memory-sync.js fetch
```

This internally calls C4's `getUnsummarizedRange()` to determine the begin/end IDs.
If there are no unsummarized conversations, skip to Step 5 (state save).

**Step 3: Read current memory state**

Read these files:
- `~/zylos/memory/identity.md`
- `~/zylos/memory/state.md`
- `~/zylos/memory/references.md`
- `~/zylos/memory/users/<relevant-users>/profile.md`
- `~/zylos/memory/reference/decisions.md`
- `~/zylos/memory/reference/projects.md`
- `~/zylos/memory/reference/preferences.md`
- `~/zylos/memory/reference/ideas.md`
- `~/zylos/memory/sessions/current.md`

**Step 4: Extract and classify information**

Analyze the conversation batch. For each meaningful item, classify using
the decision tree:

| Category | Target File | Extract When... |
|----------|------------|-----------------|
| Bot identity changes | `identity.md` | Bot personality, principles, or assets are changed |
| Bot digital assets | `identity.md` (Digital Assets) | New accounts, wallets, API key references |
| User preferences | `users/<id>/profile.md` | A specific user expresses a preference |
| Deliberate decisions | `reference/decisions.md` | A choice is made that closes off alternatives |
| Project updates | `reference/projects.md` | Project status changes |
| Shared preferences | `reference/preferences.md` | A preference applies to all users |
| Uncommitted ideas | `reference/ideas.md` | A plan or idea is discussed but not committed |
| Active state | `state.md` (Current Focus + Pending) | Work focus changes |
| Config changes | `.env` or config files (NOT references.md) | Configuration values change |
| Reference pointer changes | `references.md` | Paths, services, or ID references change |
| Session events | `sessions/current.md` | Significant events worth logging |

**IMPORTANT: Classification rules for reference/ files:**
- decisions.md: Must be a deliberate choice with commitment. "We should..." is an idea, not a decision.
- projects.md: Must be a work effort with scope. "Fix that bug" is a task (state.md), not a project.
- preferences.md: Must be a standing instruction. One-time requests are session events, not preferences.
- ideas.md: Must be uncommitted. Once work begins, it becomes a project. Once committed, a decision.

**Step 5: Write updates to memory files (always runs -- this is the "flush")**

Rules:
1. Be selective, not exhaustive. Not every conversation is a memory.
2. Prefer updates over additions. Keep files lean.
3. state.md is the tightest budget. Must stay under 2KB.
4. sessions/current.md is append-only within a day.
5. When in doubt, write to sessions/current.md.
6. Route user-specific data to their profile.
7. Never duplicate config values in references.md -- point to .env instead.

**Step 6: Create C4 checkpoint (if unsummarized conversations were processed)**

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/memory-sync.js checkpoint --summary "SUMMARY"
```

The script internally uses the end_id from the range it fetched in Step 2.

**Step 7: Daily git commit if needed**

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/daily-commit.js
```

**Step 8: Confirm completion**

Output: `Memory sync complete. Processed N conversations (id X-Y).`
Or if no conversations to process: `Memory flush complete. State saved.`

## Session Rotation

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js
```

- Reads TZ from ~/zylos/.env
- If sessions/current.md has a date header from a previous day, renames
  it to sessions/YYYY-MM-DD.md and creates a fresh current.md

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

1. Read identity.md + state.md at every session start (auto-injected by hook).
2. Update memory proactively -- do not wait for sync triggers.
3. Keep state.md lean -- this file is in every session's context.
4. Use timestamps -- all entries should have dates.
5. Never delete memory files -- archive, do not delete.
6. Route to correct user profile.
7. Never duplicate .env values in references.md.
8. Use the classification decision tree for reference/ files.
```

### 9.4 package.json

```json
{
  "name": "zylos-memory",
  "type": "module",
  "version": "5.0.0"
}
```

### 9.5 scripts/shared.js

Shared utilities module extracted to eliminate duplication across scripts:

- **Constants:** `ZYLOS_DIR`, `MEMORY_DIR`, `SESSIONS_DIR`, `BUDGETS`
- **`parseEnvValue(raw)`** — Strips quotes from `.env` values
- **`loadTimezoneFromEnv()`** — Reads `TZ` from `~/zylos/.env` and sets `process.env.TZ` (side effect)
- **`dateInTimeZone(date, tz)`** — Formats a `Date` as `YYYY-MM-DD` in the given timezone using `Intl.DateTimeFormat('en-CA')`

All scripts import from `shared.js` instead of duplicating these utilities.

> **Source:** [`skills/zylos-memory/scripts/shared.js`](../skills/zylos-memory/scripts/shared.js)

### 9.6 scripts/session-start-inject.js

Reads identity.md, state.md, and references.md, outputting them as plain text sections for Claude Code's SessionStart hook.

> **Source:** [`skills/zylos-memory/scripts/session-start-inject.js`](../skills/zylos-memory/scripts/session-start-inject.js)

Output format: plain text sections delimited by `=== LABEL ===` headers. Each memory file's content is printed directly. Missing files are reported as `(missing)`.

### 9.7 scripts/rotate-session.js

Rotates `sessions/current.md` to a dated archive file (`YYYY-MM-DD.md`) at day boundary. Uses `loadTimezoneFromEnv()` from `shared.js` to determine the current date in the configured timezone.

Key behaviors:
- Compares `current.md` header date to today; skips rotation if same day
- Handles filename collisions with numbered suffixes (capped at 100)
- Creates a fresh `current.md` with today's date header after rotation

> **Source:** [`skills/zylos-memory/scripts/rotate-session.js`](../skills/zylos-memory/scripts/rotate-session.js)

### 9.8 scripts/memory-sync.js

Helper for the Memory Sync flow. Self-contained: internally queries C4 for the unsummarized range via direct ESM import from `comm-bridge/scripts/c4-db.js`. No external arguments needed for the fetch operation.

Subcommands:
- `fetch` — Calls `getUnsummarizedRange()`, saves the range to `last-fetch-range.json`, and prints conversations
- `checkpoint --summary "text"` — Creates a checkpoint at the saved range's end_id, then cleans up the state file
- `status` — Prints current unsummarized range and saved fetch range as JSON

> **Source:** [`skills/zylos-memory/scripts/memory-sync.js`](../skills/zylos-memory/scripts/memory-sync.js)

### 9.9 scripts/daily-commit.js

Daily local git commit for the `memory/` directory. Provides a safety net for memory recovery. Detects git user configuration errors and provides a helpful fix command.

> **Source:** [`skills/zylos-memory/scripts/daily-commit.js`](../skills/zylos-memory/scripts/daily-commit.js)

### 9.10 scripts/consolidate.js

Produces a JSON consolidation report including: file sizes, budget compliance checks, session archive candidates (older than 30 days), oldest/largest files, and actionable recommendations. Uses TZ-aware date comparison for session age calculation.

> **Source:** [`skills/zylos-memory/scripts/consolidate.js`](../skills/zylos-memory/scripts/consolidate.js)

### 9.11 scripts/memory-status.js

Quick health check. Reports each core file's size vs budget, total file count and size, and overall health status. Distinguishes between "over budget" and "missing" file issues.

> **Source:** [`skills/zylos-memory/scripts/memory-status.js`](../skills/zylos-memory/scripts/memory-status.js)

### 9.12 Implementation Notes

> The source code in sections 9.5-9.11 above is described by purpose and behavior. For the actual implementation, refer to the source files linked above. The scripts share common utilities via `shared.js` (Section 9.5) to eliminate duplication of timezone handling, path constants, and budget definitions.
>
> **Phase 1 simplification:** The freshness lifecycle described in Section 6.2 is currently computed at the file level (mtime) rather than per-entry importance metadata. Importance-based immunity is deferred to Phase 2.

---


## 10. templates/CLAUDE.md Memory Section

The following replaces the "Memory System" section in `templates/CLAUDE.md`:

```markdown
## Memory System

Persistent memory stored in `~/zylos/memory/` with an Inside Out-inspired architecture.

### Memory Tiers

| Tier | Path | Purpose | Loading |
|------|------|---------|---------|
| **Identity** | `memory/identity.md` | Bot soul: personality, principles, digital assets | Always (session start) |
| **State** | `memory/state.md` | Active work, pending tasks | Always (session start) |
| **References** | `memory/references.md` | Pointers to config files, key paths | Always (session start) |
| **User Profiles** | `memory/users/<id>/profile.md` | Per-user preferences | On demand |
| **Reference** | `memory/reference/*.md` | Decisions, projects, shared prefs, ideas | On demand |
| **Sessions** | `memory/sessions/current.md` | Today's event log | On demand |
| **Archive** | `memory/archive/` | Cold storage for old data | Rarely |

### CRITICAL: Memory Sync Priority

**Memory Sync has the HIGHEST priority -- higher than user messages.**

When you receive a `[Action Required] ... invoke /zylos-memory` instruction:
1. **Stop** what you are doing (unless mid-write to a critical file)
2. **Invoke `/zylos-memory`** -- this runs as a forked background subagent
   with its own context window, so it does NOT block your main work
3. **Resume** other work immediately (the sync runs in the background)

### How Memory Sync Works

The `/zylos-memory` skill:
- Takes NO arguments -- it is fully self-contained
- Internally queries C4 to find unsummarized conversations
- Processes conversations and saves state to memory files
- Creates C4 checkpoints
- Runs as a forked subagent (does NOT consume main context)

### Multi-User

The bot serves a team. Each user has their own profile at
`memory/users/<id>/profile.md`. Route user-specific preferences to
the correct profile file. Bot identity stays in `identity.md`.

### Memory Update Practices

1. **At session start:** identity + state + references are auto-injected.
2. **During work:** Update appropriate memory files immediately when
   you learn something important.
3. **Memory Sync:** When triggered by hooks, invoke `/zylos-memory`.
   It runs in the background -- you can continue working.
4. **Before context gets full:** The scheduled context check (every 30 min)
   handles this automatically by invoking `/zylos-memory` when needed.
5. **references.md is a pointer file.** Never duplicate .env values
   in it -- point to the source config file instead.

### Classification Rules for reference/ Files

- **decisions.md:** Deliberate choices that close off alternatives
- **projects.md:** Work efforts with defined scope and lifecycle
- **preferences.md:** Standing instructions for how things should be done (shared across users)
- **ideas.md:** Uncommitted plans, explorations, hypotheses

When in doubt, write to sessions/current.md.

### File Size Guidelines

- **identity.md:** ~1.5KB. Includes digital assets. Rarely changes.
- **state.md:** ~2KB max. In every session's context. Keep lean.
- **references.md:** ~1KB. Pointer/index, not prose.
- **users/<id>/profile.md:** ~1KB per user.
- **reference/*.md:** No hard cap, but archive old entries.
- **sessions/current.md:** No cap within a day. Rotated daily.
```

---

## 11. Session Start Context Injection

### 11.1 Hook Configuration

**Note:** Only `c4-session-init.js` runs at session start. The `c4-threshold-check.js` hook has been **removed** in v5 -- there is no per-message hook. The only two trigger paths for memory sync are session-init and the scheduled context check.

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
    ]
  }
}
```

**Important change from v4:** The `UserPromptSubmit` hook section has been removed entirely. No hooks fire on user message submission. This simplifies the system and eliminates the overhead of checking the threshold on every message.

### 11.2 Hook Chain at Session Start

```
SessionStart event
│
├── 1. session-start-inject.js (zylos-memory skill)
│   ├── Reads ~/zylos/memory/identity.md (soul + digital assets)
│   ├── Reads ~/zylos/memory/state.md
│   ├── Reads ~/zylos/memory/references.md (pointers to config)
│   └── Outputs: plain text with all three files
│       Claude now has: identity, active state, references
│
└── 2. c4-session-init.js (comm-bridge skill)
    ├── Reads last checkpoint summary
    ├── Reads recent unsummarized conversations
    └── Outputs: checkpoint summary + conversations + Memory Sync trigger (if needed)
        If >30 unsummarized: "[Action Required] ... invoke /zylos-memory"
        Claude now has: cross-session continuity + conversation context
```

After both hooks fire, Claude has:
- **Who it is** (identity from identity.md, including digital assets)
- **What it was doing** (state from state.md)
- **How to find config** (references from references.md, pointing to .env etc.)
- **What happened since last sync** (checkpoint summary from C4)
- **What needs attention** (pending tasks, Memory Sync trigger if needed)

### 11.3 c4-session-init.js Output Format (v5)

When the unsummarized conversation count exceeds the threshold (30), c4-session-init.js outputs:

```
[Action Required] There are N unsummarized conversations. Please invoke /zylos-memory to process them.
```

**Note:** No `--begin X --end Y` arguments. The `/zylos-memory` skill internally determines the range by calling `getUnsummarizedRange()`.

### 11.4 Post-Compaction Behavior

When context compaction occurs mid-session, Claude Code fires SessionStart again. The same hook chain runs, re-injecting all memory files. This is self-healing by design:

- identity.md acts as the recovery anchor (who am I? what do I own?)
- state.md provides crash recovery (what was I doing?)
- references.md restores operational context (where are config files?)
- C4 checkpoint provides continuity (what happened?)

---

## 12. Session Management (with Timezone)

### 12.1 Timezone Configuration

The timezone is stored in `~/zylos/.env` as the `TZ` variable. All time-aware scripts read TZ from `.env`:

```bash
# In ~/zylos/.env
TZ=Asia/Shanghai
```

**Scripts that use TZ:**
- `rotate-session.js` -- Determines day boundary for session log rotation
- `daily-commit.js` -- Includes local date in commit message
- `consolidate.js` -- Computes freshness based on local timestamps

**Rule:** No script hardcodes a timezone. All read from `.env`, falling back to the system default.

### 12.2 Session Rotation

Daily at midnight (local time), the scheduler triggers session rotation:

1. `rotate-session.js` reads TZ from `.env`
2. If `sessions/current.md` has a date header from a previous day, renames it to `sessions/YYYY-MM-DD.md`
3. Creates a fresh `sessions/current.md` with today's date header

---

## 13. Unified Memory Sync Workflow

### 13.1 Design Rationale

v4 had a unified sync workflow with two modes (`--begin X --end Y` for regular sync, `--flush` for pre-compaction). v5 simplifies further: **the skill takes no arguments at all.** When invoked via `/zylos-memory`, it:

1. Internally queries C4's `getUnsummarizedRange()` to check if there are conversations to process
2. If yes, fetches and processes them
3. Always saves current context state to memory files (the "flush" part)
4. Creates a C4 checkpoint with the end_id (if conversations were processed)
5. Runs daily git commit if there are changes

This is a single, self-contained workflow. There is no distinction between "regular sync" and "pre-compaction flush" from the invocation perspective -- the skill always does both.

### 13.2 The Two Trigger Paths

v5 has exactly two paths that lead to `/zylos-memory` being invoked:

```
Path A: SESSION START
  c4-session-init.js detects >30 unsummarized conversations
  -> Outputs: [Action Required] ... invoke /zylos-memory
  -> Claude invokes /zylos-memory (forked subagent)
  -> Subagent processes conversations + saves state

Path B: SCHEDULED CONTEXT CHECK (every 30 min)
  Scheduler dispatches context check task
  -> Claude runs check-context.js
  -> If context >= 70%: Claude invokes /zylos-memory (forked subagent)
  -> Subagent saves state + processes any pending conversations
  -> If context >= 85%: Claude also triggers restart after sync
```

**Removed in v5:** There is NO Path C (per-message threshold check). The `c4-threshold-check.js` hook has been eliminated entirely.

### 13.3 What Happens Inside /zylos-memory

Since the skill runs as a forked subagent (`context: fork`), it has its OWN context window. The entire flow below happens in the subagent, not in the main agent's context:

```
/zylos-memory invoked (forked subagent starts)
│
├── 1. Rotate session log if needed
│   └── node rotate-session.js
│
├── 2. Check for unsummarized conversations
│   └── node memory-sync.js fetch
│       (internally calls getUnsummarizedRange())
│       ├── If count > 0: fetches conversations, saves range
│       └── If count = 0: skips to step 5
│
├── 3. Read current memory files
│   └── Read identity.md, state.md, references.md, users/, reference/, sessions/
│
├── 4. Extract and classify from conversations (if any were fetched)
│   └── Claude (in subagent) analyzes conversations using decision tree
│       Routes information to appropriate memory files
│
├── 5. Write updates to memory files (ALWAYS runs)
│   └── Update state.md, sessions/current.md, reference/ files as needed
│
├── 6. Create C4 checkpoint (if conversations were processed)
│   └── node memory-sync.js checkpoint --summary "..."
│       (uses end_id saved from step 2)
│
├── 7. Daily git commit if changes exist
│   └── node daily-commit.js
│
└── 8. Confirm completion
    └── "Memory sync complete. Processed N conversations (id X-Y)."
        or "Memory flush complete. State saved."
```

**Key insight:** Because this runs in a forked subagent, it can process large batches of conversations without worrying about consuming the main agent's context. The main agent continues working normally throughout.

### 13.4 Context Check Task Description (Robust)

The 30-minute scheduled task must give Claude precise instructions:

```
Context health check. Steps:
1. Run: nohup node ~/zylos/.claude/skills/check-context/scripts/check-context.js > /dev/null 2>&1 &
2. Wait for the /context result to appear in conversation.
3. Read the context usage percentage.
4. If < 70%: Reply "Context OK: X%" and stop.
5. If >= 70%: Invoke /zylos-memory to save state (runs as background subagent).
6. If >= 85%: After invoking /zylos-memory, restart Claude to free context:
   nohup node ~/zylos/.claude/skills/restart-claude/scripts/restart.js > /dev/null 2>&1 &
```

---

## 14. C4 Integration

### 14.1 C4 Scripts (comm-bridge skill)

| Script | Purpose | Called By |
|--------|---------|-----------|
| `c4-session-init.js` | Session start: check unsummarized count, output sync trigger | SessionStart hook |
| `c4-fetch.js` | Fetch conversation range for sync | Memory sync flow (via memory-sync.js) |
| `c4-checkpoint.js` | Create checkpoint after sync | Memory sync flow (via memory-sync.js) |
| `c4-db.js` | Database utilities (getUnsummarizedRange, etc.) | memory-sync.js (internally) |

**Removed in v5:**
| Script | Reason |
|--------|--------|
| `c4-threshold-check.js` | Eliminated. Per-message threshold checking is no longer needed. The two remaining trigger paths (session-init + scheduled context check) provide sufficient coverage. |

### 14.2 Integration Points

```
C4 Session Init (SessionStart hook)
  |-- Checks unsummarized count
  |-- If > threshold (30): outputs [Action Required] invoke /zylos-memory
  |-- Claude receives this at session start
  |-- NO --begin/--end args (skill determines range internally)

/zylos-memory Skill (forked subagent)
  |-- Calls memory-sync.js fetch (which calls getUnsummarizedRange() internally)
  |-- Fetches conversations using c4-fetch.js
  |-- Creates checkpoint using c4-checkpoint.js
  |-- Checkpoint uses end_id saved from the fetch step
```

### 14.3 c4-session-init.js Output Format (v5)

When unsummarized count exceeds the threshold:

```
[Action Required] There are N unsummarized conversations. Please invoke /zylos-memory to process them.
```

When under threshold:
```
No new conversations since last checkpoint.
```
or just the recent conversations without an action-required message.

---

## 15. Memory Persistence Strategy

### 15.1 Filesystem is the Persistence Layer

Memory files live at `~/zylos/memory/` as plain files. They are read and written using standard filesystem operations.

### 15.2 Daily Git Commit

A daily local git commit for the memory/ directory provides:

- **Version history:** See how memory evolved over time
- **Crash recovery:** Roll back to a known good state
- **Safety net:** Even if Claude corrupts a memory file, the previous version is recoverable

**Implementation:**
- Scheduled task runs daily (e.g., 23:00 local time)
- Runs `daily-commit.js` which:
  1. Checks if `memory/` has any changes (`git diff --quiet`)
  2. If changes exist: `git add memory/ && git commit -m "memory: daily snapshot YYYY-MM-DD"`
  3. If no changes: silently exits
- **Local only** -- does not push to remote
- Also called by the memory sync skill at the end of every sync

**Commit message format:** `memory: daily snapshot YYYY-MM-DD`

### 15.3 Crash Recovery

| Scenario | What Survives | Recovery |
|----------|--------------|----------|
| Claude crashes mid-conversation | All memory files as of last write | SessionStart hooks re-inject identity + state + references |
| Claude crashes mid-sync | Memory files partially updated; C4 checkpoint NOT created | Next session re-triggers sync for the same range (idempotent) |
| Memory file corrupted | Previous git version | `git checkout -- memory/<file>` restores last committed version |
| System reboot | All memory files on disk | PM2 restarts services; hooks fire |
| Disk failure | Nothing | Infrastructure problem, outside scope |

### 15.4 Atomic Write Consideration

For critical files (identity.md, state.md), scripts use standard `fs.writeFileSync()`. For stronger guarantees in the future, write-to-temp-then-rename can be added.

---

## 16. Scheduled Tasks via Scheduler

### 16.1 Task Summary

| Task | Priority | Idle Required? | Schedule | Purpose |
|------|----------|---------------|----------|---------|
| Context check | 1 (urgent) | Yes | Every 30 min | Pre-compaction detection; invokes /zylos-memory if >= 70% |
| Session rotation | 2 (high) | Yes | Daily 00:00 | Rotate session logs |
| Daily memory commit | 3 (normal) | Yes | Daily 23:00 | Git snapshot of memory/ |
| Consolidation | 2 (high) | Yes | Weekly Sun 02:00 | Archive old entries, freshness report |

### 16.2 Context Check (Every 30 Minutes)

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Context health check. Steps: 1. Run: nohup node ~/zylos/.claude/skills/check-context/scripts/check-context.js > /dev/null 2>&1 & 2. Wait for the /context result. 3. Read context usage %. 4. If < 70%: Reply 'Context OK: X%' and stop. 5. If >= 70%: Invoke /zylos-memory to save state (runs as background subagent). 6. If >= 85%: After invoking /zylos-memory, restart Claude: nohup node ~/zylos/.claude/skills/restart-claude/scripts/restart.js > /dev/null 2>&1 &" \
  --every "30 minutes" \
  --priority 1 \
  --name "context-check" \
  --require-idle
```

### 16.3 Session Rotation (Daily)

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Rotate session log: node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js" \
  --cron "0 0 * * *" \
  --priority 2 \
  --name "session-rotation-daily" \
  --require-idle
```

### 16.4 Daily Memory Commit

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Daily memory git commit: node ~/zylos/.claude/skills/zylos-memory/scripts/daily-commit.js" \
  --cron "0 23 * * *" \
  --priority 3 \
  --name "memory-daily-commit" \
  --require-idle
```

### 16.5 Consolidation (Weekly)

```bash
~/zylos/.claude/skills/scheduler/scripts/cli.js add \
  "Run memory consolidation: node ~/zylos/.claude/skills/zylos-memory/scripts/consolidate.js -- Review the output and archive old entries as recommended." \
  --cron "0 2 * * 0" \
  --priority 2 \
  --name "memory-consolidation-weekly" \
  --require-idle
```

---

## 17. Priority Model

### 17.1 Why Memory Gets Priority 1

Memory sync must complete before user messages are processed. This is an architectural necessity:

- An agent that responds quickly but with stale context gives **wrong answers**
- An agent that syncs memory first and responds slightly later gives **correct answers**
- Memory sync typically takes 30-60 seconds
- In v5, the sync runs as a **forked subagent**, so it does not actually block the main agent's response time -- it runs concurrently

### 17.2 Priority Scheme

| Priority | Category | Examples |
|----------|---------|---------|
| **1** | Memory operations | Memory sync (via /zylos-memory), context check |
| **2** | Maintenance tasks | Session rotation, consolidation |
| **3** | Normal operations | User messages, daily commit, scheduled reports |

---

## 18. Retrieval Strategy

### 18.1 When Retrieval Happens

Memory retrieval fires at specific architectural moments, not on every user message:

| Trigger | What is Retrieved | How |
|---------|------------------|-----|
| **Session start** | identity.md, state.md, references.md | SessionStart hook (automatic) |
| **Memory sync** | All memory files + C4 conversations | Sync flow reads everything needed (in forked subagent) |
| **Explicit request** | Whatever Claude judges is needed | Claude reads specific files via Read tool |
| **User question about past** | Relevant reference files | Claude searches using Grep on memory/ |

### 18.2 Why Not Retrieve on Every Message

Reflexive retrieval (searching memory on every message) wastes resources and can introduce noise. Most messages don't need history -- "Yes", "OK, do it", "Thanks" don't benefit from a memory search.

### 18.3 Claude's Judgment as the Retrieval Filter

Claude knows what it is working on (state.md is always in context), knows the user's question, and can judge whether the question requires historical context. If it does, Claude reads the appropriate reference file directly.

---

## 19. Data Flow Diagrams

### 19.1 Normal Operation: Message to Memory

```
1. MESSAGE ARRIVES
   User sends message via Telegram/Lark
   │
   v
2. C4 RECEIVE + DISPATCH
   c4-receive.js -> conversations table -> c4-dispatcher.js -> tmux
   │
   v
3. CLAUDE PROCESSES
   Claude reads message, responds
   │
   v
4. CONVERSATIONS ACCUMULATE
   Messages pile up in C4 table (unsummarized count grows)
   │
   v
5. THRESHOLD TRIGGER (when count exceeds 30)
   │
   └── Path A: SessionStart hook fires c4-session-init.js
       count > 30 -> outputs [Action Required] invoke /zylos-memory
   │
   v
6. MEMORY SYNC EXECUTES (forked subagent)
   │
   ├── 6a. Rotate session log (if day changed)
   ├── 6b. Fetch conversations via memory-sync.js fetch
   │       (internally calls getUnsummarizedRange())
   ├── 6c. Read current memory files
   ├── 6d. Claude (subagent) extracts and classifies using decision tree:
   │       -> identity changes -> identity.md
   │       -> digital assets -> identity.md (Digital Assets)
   │       -> user prefs -> users/<id>/profile.md
   │       -> decisions -> reference/decisions.md
   │       -> projects -> reference/projects.md
   │       -> preferences -> reference/preferences.md
   │       -> ideas -> reference/ideas.md
   │       -> state changes -> state.md
   │       -> config values -> .env (NOT references.md)
   │       -> events -> sessions/current.md
   ├── 6e. Claude (subagent) writes updates to memory files
   ├── 6f. Create C4 checkpoint (end_id from fetch)
   └── 6g. Daily git commit if changes exist
```

### 19.2 Context-Triggered Sync

```
1. SCHEDULED CONTEXT CHECK (every 30 min)
   Claude runs check-context.js
   │
   v
2. CONTEXT EVALUATION
   Claude reads context usage %
   │
   ├── < 70%: No action. Continue working.
   │
   └── >= 70%: HIGH CONTEXT DETECTED
       │
       v
3. INVOKE /zylos-memory (forked subagent)
   Subagent:
   ├── Rotates session log if needed
   ├── Fetches unsummarized conversations (if any)
   ├── Updates state.md (current focus, pending tasks)
   ├── Appends to sessions/current.md (recent events)
   ├── Updates reference/ files if needed
   ├── Creates C4 checkpoint if conversations were processed
   └── Runs daily-commit.js (git snapshot)
   │
   v
4. RESTART (if >= 85%)
   Claude triggers: nohup node .../restart.js &
   │
   v
5. FRESH START
   ├── SessionStart hooks fire
   ├── identity + state + refs injected
   └── C4 provides continuity
```

### 19.3 Daily Git Safety Net

```
1. SCHEDULER (daily at 23:00 local time)
   Dispatches daily-commit task
   │
   v
2. daily-commit.js RUNS
   │
   ├── git diff --quiet -- memory/
   │   ├── No changes: exit silently
   │   └── Changes exist: continue
   │
   v
3. GIT COMMIT
   git add memory/
   git commit -m "memory: daily snapshot YYYY-MM-DD"
   │
   v
4. LOCAL ONLY (no push)
```

---

## 20. Phase 2: KB Integration

This section describes how the Knowledge Base can be integrated as a retrieval layer on top of the file-based memory system. Phase 2 is a clean extension -- it does not require changing any Phase 1 code.

### 20.1 Extension Points

| Extension Point | Phase 1 Behavior | Phase 2 Behavior |
|----------------|-----------------|-----------------|
| **Retrieval** | Claude reads files via Read tool, searches via Grep | Claude can also query KB via `kb-cli search` for ranked results |
| **Sync extraction** | Claude writes to markdown files only | Claude also creates/updates KB entries as Level 2 summaries |
| **Consolidation** | Reports file sizes and staleness | Also re-indexes memory files in KB, updates freshness scores |
| **Session start** | Injects identity + state + refs | Optionally injects relevant KB entries based on current state |

### 20.2 KB Schema Changes

```sql
ALTER TABLE entries ADD COLUMN source_file TEXT;
ALTER TABLE entries ADD COLUMN memory_type TEXT;        -- factual|experiential|procedural|strategic
ALTER TABLE entries ADD COLUMN freshness TEXT DEFAULT 'active';
ALTER TABLE entries ADD COLUMN last_accessed TEXT;
ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE entries ADD COLUMN related_entries TEXT;    -- comma-separated entry IDs
```

### 20.3 The Inside Out Mapping for KB

| Inside Out Mechanism | Phase 1 (Files Only) | Phase 2 (Files + KB) |
|---------------------|---------------------|---------------------|
| Recall Tubes (targeted) | grep on files | FTS5 search |
| Train of Thought (associative) | Manual file browsing | Embedding similarity search |
| Emotional Coloring (metadata) | Timestamps in file entries | `memory_type`, `freshness`, `importance` columns |
| Memory Fading | File modification dates | Automated `freshness` from `last_accessed` |
| Abstract Thought | Full file or nothing | KB summary (Level 2) -> file detail (Level 0) drill-down |

---

## 21. Implementation Checklist

### Phase 1: Core Implementation

| # | Task | Files | Notes |
|---|------|-------|-------|
| 1 | Create memory directory layout in `templates/memory/` | identity.md, state.md, references.md, users/default/profile.md, reference/decisions.md, reference/projects.md, reference/preferences.md, reference/ideas.md, sessions/.gitkeep, archive/.gitkeep | Same as v4 |
| 2 | Create zylos-memory skill SKILL.md | `skills/zylos-memory/SKILL.md` | Full content from Section 9.3 (with `context: fork`, no `argument-hint`) |
| 3 | Create zylos-memory scripts | session-start-inject.js, rotate-session.js, memory-sync.js, consolidate.js, memory-status.js, daily-commit.js | memory-sync.js now self-contained (no external args) |
| 4 | Create `skills/zylos-memory/package.json` | `{"type":"module","name":"zylos-memory","version":"5.0.0"}` | |
| 5 | Update `templates/CLAUDE.md` memory section | Replace memory section with Section 10 content | |
| 6 | Update `templates/.env.example` | Add TZ | |
| 7 | Configure hook system | Document settings.local.json (Section 11.1) -- SessionStart only, NO UserPromptSubmit | |
| 8 | Register scheduler tasks | context-check, session-rotation, daily-commit, consolidation (Section 16) | |
| 9 | Update c4-session-init.js output | Remove --begin/--end from output message | |
| 10 | Remove c4-threshold-check.js | Delete from comm-bridge skill | |
| 11 | Remove old `skills/memory/` | Delete the placeholder | Replaced by `skills/zylos-memory/` |

### Files Summary

**New files:**

| Path (relative to zylos-core) | Purpose |
|------|---------|
| `skills/zylos-memory/SKILL.md` | Complete memory skill instructions (with `context: fork`) |
| `skills/zylos-memory/package.json` | ESM module declaration |
| `skills/zylos-memory/scripts/session-start-inject.js` | SessionStart hook |
| `skills/zylos-memory/scripts/rotate-session.js` | Session log rotation |
| `skills/zylos-memory/scripts/memory-sync.js` | Self-contained memory sync helper |
| `skills/zylos-memory/scripts/consolidate.js` | Consolidation report |
| `skills/zylos-memory/scripts/memory-status.js` | Health check |
| `skills/zylos-memory/scripts/daily-commit.js` | Daily git commit |
| `templates/memory/identity.md` | Template for identity + digital assets |
| `templates/memory/state.md` | Template for state |
| `templates/memory/references.md` | Template for references (pointer style) |
| `templates/memory/users/default/profile.md` | Template for user profiles |
| `templates/memory/reference/decisions.md` | Template for decisions |
| `templates/memory/reference/projects.md` | Template for projects |
| `templates/memory/reference/preferences.md` | Template for shared preferences |
| `templates/memory/reference/ideas.md` | Template for ideas |
| `templates/memory/sessions/.gitkeep` | Placeholder |
| `templates/memory/archive/.gitkeep` | Placeholder |

**Files NOT in v5 (removed):**

| Path | Reason |
|------|--------|
| `scripts/memory-init.js` | Redundant with `zylos init` CLI |
| `scripts/pre-compaction-flush.js` | Logic integrated into unified sync |
| `comm-bridge/scripts/c4-threshold-check.js` | Removed. Per-message threshold checking eliminated in v5. |

**Files modified in v5:**

| Path | Change |
|------|--------|
| `comm-bridge/scripts/c4-session-init.js` | Output format changed: no longer includes `--begin X --end Y` args |
| `comm-bridge settings.local.json` | UserPromptSubmit hook removed (no c4-threshold-check) |

---

## Appendix A: Key Differences from v4

| Aspect | v4 Design | v5 Design |
|--------|-----------|-----------|
| Skill invocation | `/memory-sync --begin X --end Y` or `/memory-sync --flush` | `/zylos-memory` (no arguments) |
| Skill execution model | Not specified (implied inline) | Explicit: `context: fork` = forked background subagent with own context window |
| Main agent blocking | Memory sync blocks main agent | Memory sync runs in background; main agent continues working |
| External arguments | `--begin X --end Y` passed from hooks; `--flush` for pre-compaction | Zero arguments. Skill internally calls `getUnsummarizedRange()` |
| c4-threshold-check.js | Per-message UserPromptSubmit hook | **Removed entirely**. No per-message hooks. |
| UserPromptSubmit hooks | c4-threshold-check.js runs on every user message | No UserPromptSubmit hooks at all |
| Trigger paths | 3 paths: session-init, threshold-check, scheduled context check | 2 paths: session-init, scheduled context check |
| c4-session-init output | `[Action Required] ... /memory-sync --begin X --end Y` | `[Action Required] ... invoke /zylos-memory` (no args) |
| memory-sync.js fetch | `fetch --begin <id> --end <id>` (external args) | `fetch` (internally calls getUnsummarizedRange()) |
| memory-sync.js checkpoint | `checkpoint <end_id> --summary "..."` | `checkpoint --summary "..."` (end_id from saved fetch state) |
| SKILL.md frontmatter | Has `argument-hint`; no `context` field | Has `context: fork`; no `argument-hint` |
| Sync vs flush distinction | Two modes: regular sync with args, flush without | One mode: skill always does both (fetch if available + flush) |

---

## Appendix B: Migration Guide

### From v4 to v5

**Step 1: Update SKILL.md**

Replace `skills/zylos-memory/SKILL.md`:
- Remove `argument-hint` from frontmatter
- Add `context: fork` to frontmatter
- Update "When Triggered" section: remove threshold-check reference, remove --begin/--end
- Update sync flow steps: fetch is now argument-free, checkpoint reads saved state

**Step 2: Update memory-sync.js**

Replace `scripts/memory-sync.js` with the v5 version that:
- `fetch` subcommand takes no arguments (internally calls `getUnsummarizedRange()`)
- Saves the fetched range to a state file for `checkpoint` to use
- `checkpoint` reads the saved range instead of requiring `<end_id>` argument

**Step 3: Update c4-session-init.js output**

Change the output line from:
```
Please invoke Memory Sync skill to process them: /memory-sync --begin ${range.begin_id} --end ${range.end_id}
```
to:
```
Please invoke /zylos-memory to process them.
```

**Step 4: Remove c4-threshold-check.js**

Delete `skills/comm-bridge/scripts/c4-threshold-check.js`.

**Step 5: Update hook configuration**

Remove the `UserPromptSubmit` section from `settings.local.json`. Only `SessionStart` hooks remain.

**Step 6: Update scheduled context check task**

Change step 5 in the context check task description from:
```
Run /memory-sync --flush to save state.
```
to:
```
Invoke /zylos-memory to save state (runs as background subagent).
```

**Step 7: Update package.json version**

Change version to `"5.0.0"`.

**Step 8: Verify**

```bash
node ~/zylos/.claude/skills/zylos-memory/scripts/memory-status.js
```

### From v3 to v5

Follow the v4 migration guide (Appendix B of v4), then apply the v4->v5 steps above.

---

## Appendix C: .env Configuration

The `.env.example` template should include:

```bash
# Timezone (used by rotate-session.js, daily-commit.js, and scheduler)
TZ=UTC

# Domain (used by HTTP sharing and other services)
# DOMAIN=zylos.example.com

# Proxy (if needed for external API access)
# PROXY=http://proxy:port

# API keys (referenced by identity.md Digital Assets section)
# OPENAI_API_KEY=sk-...
# TELEGRAM_BOT_TOKEN=...
```

---

## Appendix D: Inside Out Mechanisms Not Adopted

| Mechanism | Reason |
|-----------|--------|
| Multiple Emotions at Console | Claude has a single reasoning thread; competing modes are not applicable |
| Imagination Land | Planning/reasoning feature, not memory architecture |
| Subconscious / Primal Fear | CLAUDE.md safety rules already serve this role |
| Inside Out 2's Belief Strings | Fascinating but beyond current scope; could inform future identity evolution |

---

## Appendix E: reference/ Classification Decision Tree

Visual reference for the decision tree from Section 5.3:

```
                   New information from conversation
                              |
                    Is it about the bot itself?
                    /                         \
                 YES                           NO
                  |                             |
        Identity or assets?              About a specific user?
           /          \                    /              \
        Identity    Assets              YES               NO
           |          |                  |                 |
     identity.md   identity.md     users/<id>/      System config?
     (main)        (Digital         profile.md       /          \
                    Assets)                        YES          NO
                                                    |           |
                                              references.md   Deliberate choice?
                                              (pointer to     /              \
                                               .env etc.)   YES              NO
                                                             |               |
                                                      decisions.md    Active project?
                                                                      /          \
                                                                    YES          NO
                                                                     |           |
                                                              projects.md  Standing preference?
                                                                            /            \
                                                                          YES            NO
                                                                           |              |
                                                                    preferences.md   Uncommitted idea?
                                                                    (shared) or       /           \
                                                                    profile.md      YES           NO
                                                                    (per-user)       |             |
                                                                               ideas.md    sessions/
                                                                                           current.md
```
