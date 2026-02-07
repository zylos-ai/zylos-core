# OpenClaw vs Zylos v2: Memory System Comparison

**Date:** 2026-02-07
**Author:** Comparison Analyst (Zylos Research Team)
**Sources:** OpenClaw research report, Zylos v2 architecture design, Zylos v2 implementation plan

---

## 1. Executive Summary

- **OpenClaw's hybrid search (BM25 + vector) is a significant capability gap.** Zylos v2 relies on grep for archive retrieval, while OpenClaw provides sub-100ms semantic search across 10K+ chunks with automatic fallback. This is the single biggest area where OpenClaw is ahead.
- **Zylos v2's priority model is more principled.** Zylos explicitly prioritizes memory sync above user messages (priority 1 vs 3), backed by a scheduler and C4 queue integration. OpenClaw's pre-compaction flush is reactive and silent; it does not preempt user interactions.
- **OpenClaw's embedding provider chain is production-hardened.** Auto-selecting from local GGUF to OpenAI to Gemini with graceful degradation gives OpenClaw resilience that Zylos v2 does not attempt. Zylos has no embedding or vector capability at all.
- **Zylos v2's architecture is simpler and more transparent.** Plain markdown files, no SQLite, no embeddings, no vector indexes. This is both a strength (debuggability, human readability, zero dependencies) and a weakness (no semantic retrieval, linear search scaling).
- **OpenClaw's workspace identity files (SOUL.md, USER.md, IDENTITY.md) offer finer-grained persona control** compared to Zylos's single core.md, which bundles identity, user profile, and working state into one 3KB file.

---

## 2. Feature-by-Feature Comparison

| Dimension | OpenClaw | Zylos v2 | Assessment |
|-----------|----------|----------|------------|
| **Memory file structure** | Flat: MEMORY.md + daily logs + session JSONL | Hierarchical: core.md, reference/, sessions/, archive/ | Zylos is more organized; OpenClaw is simpler |
| **Number of tiers** | 3 (Durable, Daily, Session) | 4 (Core, Reference, Session, Archive) | Comparable. Zylos's reference tier adds structure |
| **Hot tier (always loaded)** | MEMORY.md + today's + yesterday's daily logs | core.md only (~3KB cap) | OpenClaw loads more context automatically; Zylos is leaner |
| **Warm tier (on demand)** | Past daily logs via semantic search | reference/*.md via Read tool | OpenClaw has semantic search; Zylos requires manual reads |
| **Cold tier** | Session JSONL (experimental) | archive/ (grep searchable) | Both sparse; OpenClaw has delta-based indexing |
| **Identity files** | 6 separate files (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md) | 1 file (core.md) | OpenClaw has more granular separation of concerns |
| **Session log format** | Daily markdown (YYYY-MM-DD.md), append-only | current.md (rotated daily to YYYY-MM-DD.md) | Nearly identical approach |
| **Persistence mechanism** | Filesystem + recommended Git backup | Filesystem only (no Git, per Howard's directive) | Both file-first; OpenClaw encourages Git |
| **Search capability** | Hybrid BM25 + Vector (70/30 weighted fusion) | Grep on archive; manual Read for reference files | OpenClaw vastly superior |
| **Embedding support** | 3-tier auto-selection (local GGUF, OpenAI, Gemini) | None | Major capability gap for Zylos |
| **Database** | SQLite with sqlite-vec + FTS5 per agent | None (pure filesystem) | OpenClaw has structured indexing; Zylos is zero-dependency |
| **Pre-compaction handling** | Silent agentic turn before context truncation | Priority-1 scheduler task + hook-based core.md injection | Both handle compaction; different mechanisms |
| **Context injection at session start** | MEMORY.md + today's + yesterday's logs auto-loaded | core.md injected via SessionStart hook | Both inject context; Zylos is more selective |
| **Crash recovery** | Reads files from disk; no special mechanism described | C4 checkpoint system provides idempotent sync boundary | Zylos has more explicit crash recovery design |
| **Priority model** | Not explicitly defined; pre-compaction flush is an implementation detail | Memory sync = priority 1, user messages = priority 3 | Zylos is explicitly designed for memory-first priority |
| **Scheduled maintenance** | Not described (manual or plugin-driven) | 3 scheduler tasks: sync (2h), rotation (daily), consolidation (weekly) | Zylos has comprehensive scheduled maintenance |
| **Scalability** | Sub-100ms search over 10K chunks; delta-based indexing | Linear grep over archive; no indexing | OpenClaw scales better for large memory stores |
| **Human readability** | High (markdown files, human-editable) | High (markdown files, human-editable) | Both excellent |
| **Privacy** | MEMORY.md excluded from group sessions; local-first by default | No multi-user concept; single-user by design | OpenClaw has explicit privacy boundaries |
| **Extension/plugin system** | Mem0 (structured facts), Cognee (graph knowledge), Skills | Skills system only | OpenClaw has richer extension ecosystem |
| **Multi-agent isolation** | Per-agent SQLite namespaces | Not addressed in v2 design | OpenClaw is ahead on multi-agent |
| **Chunking algorithm** | 400-token chunks with 80-token overlap, line-aware, SHA-256 dedup | None (no chunking needed without search index) | N/A for Zylos current design |
| **Configuration** | Extensive JSON config (weights, thresholds, providers, fallbacks) | Minimal (file size caps, scheduler intervals) | OpenClaw is more configurable; Zylos is simpler |
| **Script language** | Node.js (mixed ESM/CJS in codebase) | Node.js ESM only (strict requirement) | Zylos has cleaner module discipline |

---

## 3. What OpenClaw Does Better

### 3.1 Hybrid Search is a Game-Changer

OpenClaw's BM25 + vector search with weighted fusion (70% vector, 30% keyword) is the single most impactful capability difference. It enables:

- **Semantic recall**: "What did we decide about the deployment architecture?" finds relevant content even if those exact words were never used.
- **Exact token recall**: Error codes, function names, and identifiers are found via BM25 even when semantically distant.
- **Graceful degradation**: If embeddings fail, BM25 continues. If FTS fails, vectors continue. The system always works.

Zylos v2 relies on Claude manually reading files or grepping archives. This works for small memory stores but does not scale, and it lacks semantic understanding entirely.

### 3.2 Embedding Provider Chain

The auto-selection chain (local GGUF -> OpenAI -> Gemini -> Voyage) is elegant:

- **Privacy-first default**: Local embeddings via `embeddinggemma-300M-Q8_0.gguf` means no data leaves the machine.
- **Performance fallback**: Cloud providers offer 20x faster embedding when local processing is too slow.
- **Cache-first design**: SHA-256 deduplication eliminates redundant API calls across sessions.

Zylos has no embedding capability at all. Adding even BM25/FTS5 search would be a significant improvement without requiring external APIs.

### 3.3 Workspace Identity Separation

OpenClaw distributes identity across multiple focused files:

| File | Purpose |
|------|---------|
| AGENTS.md | Operating instructions |
| SOUL.md | Persona and behavioral boundaries |
| USER.md | User identity and preferences |
| IDENTITY.md | Agent name and visual identity |
| TOOLS.md | Tool usage conventions |

Zylos bundles all of this into `core.md` (with a 3KB cap) and `reference/preferences.md`. The separation allows OpenClaw to evolve persona independently of user preferences or tool conventions. It also makes it easier for users to customize one aspect without touching others.

### 3.4 Daily Context Loading

OpenClaw automatically loads today's AND yesterday's daily logs at session start. This provides a 48-hour rolling context window without requiring the agent to do anything. Zylos only loads core.md at session start; session logs must be manually read.

### 3.5 Third-Party Memory Extensions

The Mem0 and Cognee plugins demonstrate extensibility that Zylos does not currently match:

- **Mem0**: Automatically extracts structured facts (name, tech stack, project structure) from conversations and recalls them on every turn. This is persistent fact extraction that survives across all sessions.
- **Cognee**: Graph-based knowledge representation adds reasoning capabilities over stored memories.

Both represent approaches to memory that go beyond file-based storage.

### 3.6 Delta-Based Indexing

OpenClaw's session memory uses delta-based indexing triggered by content thresholds (100KB new data or 50 new JSONL lines). This means the search index stays current without full re-indexing. Zylos has no indexing mechanism at all.

---

## 4. What Zylos v2 Does Better

### 4.1 Explicit Priority Model

Zylos v2's most distinctive design choice is making memory sync priority 1 (above user messages at priority 3). This is backed by:

- **Scheduler integration**: Memory sync tasks are dispatched at priority 1 through the C4 queue.
- **Hook-based triggers**: C4 threshold checks fire on every user message, ensuring sync is triggered proactively.
- **Documented rationale**: "An agent without synced memory gives wrong answers. A slightly delayed response with full context is always better."

OpenClaw's pre-compaction flush is reactive (fires when context is near-full) and silent (uses NO_REPLY). It does not preempt normal operations. There is no documented priority model for memory operations vs user interactions.

### 4.2 Crash Recovery Design

Zylos v2 has an explicit, well-documented crash recovery path:

1. Activity monitor detects Claude not running.
2. Restarts Claude via tmux.
3. SessionStart hooks fire, injecting core.md + C4 checkpoint.
4. C4 checkpoint system ensures idempotent re-sync (no checkpoint = re-process same range).

The key insight is that compaction, crash, and fresh start all converge on the same hook chain. OpenClaw's docs do not describe a comparable explicit crash recovery mechanism.

### 4.3 Scheduled Consolidation

Zylos v2 defines three scheduled maintenance tasks:

| Task | Schedule | Purpose |
|------|----------|---------|
| Memory sync | Every 2-4 hours | Process unsummarized conversations |
| Session rotation | Daily at 00:05 | Rotate current.md to dated archive |
| Consolidation | Weekly (Sunday 03:00) | Archive old entries, check file sizes |

OpenClaw does not describe scheduled maintenance. Daily logs accumulate; there is no documented consolidation or archival process.

### 4.4 Claude-in-the-Loop Extraction

Zylos v2 deliberately puts Claude's reasoning at the center of memory extraction:

> "Claude does the extraction. Memory Sync is a Claude Code skill, not an automated background script. Claude reads raw conversations and uses its reasoning to decide what to extract."

OpenClaw's automatic fact extraction (via Mem0) is convenient but less precise. Having Claude classify information into decisions, preferences, projects, and session events produces more nuanced memory than automated keyword/entity extraction.

### 4.5 Zero External Dependencies

Zylos v2's memory system requires:
- Node.js (already present)
- Filesystem (always present)
- Claude Code hooks (native feature)

It does not require SQLite, sqlite-vec, FTS5, embedding models, or any external API. This makes it deployable anywhere Claude Code runs with zero additional setup. OpenClaw requires SQLite with extensions, optionally embedding models, and has a more complex dependency chain.

### 4.6 Size-Budgeted Core Memory

The 3KB cap on core.md is a disciplined constraint that forces the agent to keep its always-loaded context lean. OpenClaw loads MEMORY.md without a documented size cap, plus two daily logs. This could lead to context bloat over time, especially since MEMORY.md grows with user interactions.

### 4.7 No Git for Memory (Deliberate Simplification)

Howard's directive to eliminate Git from the memory persistence path removes an entire class of failure modes:
- No merge conflicts
- No dirty state from interrupted commits
- No .git directory growing with every sync cycle
- No staging/commit overhead on frequent writes

OpenClaw recommends Git backup for the workspace but does not require it at runtime. Zylos goes further by explicitly prohibiting it.

---

## 5. Ideas to Adopt from OpenClaw

### 5.1 Add SQLite FTS5 Search (High Priority)

**What:** Add a BM25 full-text search index over memory files using SQLite FTS5.

**Why:** This is already in Zylos v2's "Phase 2: Enhancements" list. OpenClaw proves this is practical with sub-100ms search latency over 10K chunks. Zylos already has a knowledge base using SQLite FTS5 (`~/zylos/knowledge-base/`), so the pattern is familiar.

**How to implement:**
1. Create a `memory-index.js` script that reads all memory files, chunks them (use OpenClaw's 400-token / 80-token overlap approach), and inserts into an FTS5 virtual table.
2. Add a `memory-search.js` tool that queries the FTS5 index and returns ranked snippets with source attribution.
3. Register a scheduler task to rebuild the index after each memory sync.
4. Add a `memory_search` instruction to SKILL.md so Claude knows to search before reading full files.

**Effort:** Medium (2-3 days). Reuse patterns from the existing KB system.

### 5.2 Separate Identity Files (Medium Priority)

**What:** Split core.md into multiple focused files: `identity.md`, `user-profile.md`, and `working-state.md`.

**Why:** OpenClaw's separation of AGENTS.md, SOUL.md, USER.md, and IDENTITY.md allows independent evolution of each concern. Zylos's core.md bundles everything under a 3KB cap, which means identity information competes with working state for space.

**How to implement:**
1. Split core.md's Identity and User Profile sections into `core/identity.md` and `core/user-profile.md` (stable, rarely changing).
2. Keep `core/working-state.md` as the frequently-updated file (active tasks, pending items, key references).
3. The SessionStart hook injects all three, but only `working-state.md` is constrained to ~2KB.
4. The stable files can be larger since they change rarely.

**Effort:** Small (half a day). Mostly updating the hook script and SKILL.md.

### 5.3 Auto-Load Yesterday's Session Log (Low Priority)

**What:** At session start, inject yesterday's session log alongside core.md.

**Why:** OpenClaw loads today's + yesterday's logs automatically, providing a 48-hour context window. Zylos only loads core.md. Adding yesterday's log would improve cross-day continuity, especially for tasks that span overnight periods.

**How to implement:**
1. Modify `session-start-inject.js` to also read `sessions/YYYY-MM-DD.md` for yesterday's date.
2. Append it to the additionalContext output (after core.md content).
3. Cap it: if yesterday's log exceeds 2KB, truncate to the last 2KB.

**Effort:** Tiny (1 hour). Single script modification.

**Trade-off:** Increases session start context by up to 2KB. Worth it for cross-day continuity.

### 5.4 Consider Local Embeddings for Semantic Search (Future)

**What:** Add optional vector search using a local embedding model.

**Why:** OpenClaw's hybrid search (BM25 + vector) demonstrates that semantic retrieval significantly improves recall quality. The local-first approach (embeddinggemma-300M-Q8_0.gguf, ~600MB) preserves privacy.

**How to implement (future enhancement):**
1. Add `sqlite-vec` extension to the memory search SQLite database.
2. Use `node-llama-cpp` with a small embedding model for local inference.
3. Store embeddings alongside FTS5 entries in the same database.
4. Implement weighted fusion (OpenClaw's 70/30 vector/keyword split is a good starting point).

**Effort:** Large (1-2 weeks). This is a Phase 2+ enhancement.

**Constraint:** The 2-core, 3.3GB RAM environment may struggle with local embedding inference. Cloud embeddings (OpenAI's text-embedding-3-small) are faster but require API keys and have cost implications. This should be optional.

### 5.5 Pre-Compaction Memory Flush (Medium Priority)

**What:** Add an automatic memory save step that fires before context compaction, separate from the scheduled sync.

**Why:** OpenClaw's automatic pre-compaction flush (silent agentic turn before truncation) ensures no context is lost during compaction. Zylos v2 relies on the scheduled sync and manual proactive saves. If compaction happens between sync cycles, recent context could be lost.

**How to implement:**
1. Zylos already has a context monitor (`context-monitor.sh`) that detects 75%+ usage.
2. Instead of (or in addition to) the current two-step compact flow, add a pre-compaction hook that triggers a lightweight memory save: update core.md's Active Working State and append key events to sessions/current.md.
3. This should be faster than a full Memory Sync (no C4 fetch needed, just save what is currently in context).

**Effort:** Small (half a day). The infrastructure (context monitor, hooks) already exists.

### 5.6 Plugin/Extension Architecture for Memory Providers (Future)

**What:** Design a plugin interface for alternative memory backends.

**Why:** OpenClaw's support for Mem0 (structured facts), Cognee (graph knowledge), and QMD (alternative search backend) shows that different use cases benefit from different memory representations. A plugin architecture would let Zylos users choose their memory backend without changing the core skill.

**How to implement (future):**
1. Define a memory provider interface: `search(query)`, `index(files)`, `status()`.
2. The default provider is filesystem + FTS5 (from idea 5.1).
3. Optional providers could include: vector search, graph DB, cloud-hosted memory.
4. The SKILL.md instructions remain the same; only the search implementation changes.

**Effort:** Large. This is a v3 concept, not a v2 enhancement.

---

## 6. Conclusion and Recommendations

### Overall Assessment

OpenClaw and Zylos v2 approach the same fundamental problem -- persistent memory for LLM agents -- with different philosophies:

- **OpenClaw** invests heavily in **retrieval quality** (hybrid search, embeddings, chunking) and **extensibility** (plugins, multi-backend support). It assumes the memory store will grow large and the agent needs sophisticated search to find relevant information.

- **Zylos v2** invests heavily in **operational reliability** (priority model, crash recovery, scheduled maintenance, idempotent sync) and **simplicity** (no external dependencies, pure filesystem, Claude-in-the-loop reasoning). It assumes the memory store stays manageable through active pruning and consolidation.

Neither approach is strictly superior. OpenClaw is better for agents with large, growing memory stores that need semantic retrieval. Zylos v2 is better for agents that need rock-solid operational guarantees with minimal infrastructure.

### Priority Recommendations for Zylos v2

| Priority | Recommendation | Effort | Impact |
|----------|---------------|--------|--------|
| 1 | Add FTS5 search over memory files (5.1) | Medium | High -- closes the biggest capability gap |
| 2 | Pre-compaction memory flush (5.5) | Small | Medium -- reduces context loss risk |
| 3 | Separate identity files (5.2) | Small | Medium -- better separation of concerns |
| 4 | Auto-load yesterday's session log (5.3) | Tiny | Low-Medium -- improves cross-day continuity |
| 5 | Local embeddings for semantic search (5.4) | Large | High -- but defer to Phase 2+ |
| 6 | Plugin architecture (5.6) | Large | Medium -- defer to v3 |

### Bottom Line

Zylos v2 is a solid, well-designed memory system that excels at operational reliability. The most impactful improvement would be adding FTS5 search (borrowing OpenClaw's approach but without the vector/embedding complexity) -- this would close the retrieval gap while preserving Zylos's zero-dependency simplicity. The pre-compaction flush and identity file separation are quick wins that further harden the system.

OpenClaw's biggest lesson for Zylos: **as memory grows, search becomes essential.** Zylos should plan for the day when grep and manual file reads are no longer sufficient.
