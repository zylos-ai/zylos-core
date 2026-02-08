# Industry Survey: AI Agent Memory Systems

**Date:** 2026-02-06
**Purpose:** Comprehensive survey of memory solutions for AI agents, with analysis of relevance to Zylos (CLI-based AI agent, tmux, file-based memory, KB with SQLite FTS5)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [MemGPT / Letta](#2-memgpt--letta)
3. [claude-mem](#3-claude-mem)
4. [Mem0](#4-mem0)
5. [Zep](#5-zep)
6. [LangChain / LangGraph Memory](#6-langchain--langgraph-memory)
7. [OpenAI's Built-in Memory](#7-openais-built-in-memory)
8. [Academic Research](#8-academic-research-2025-2026)
9. [Cross-Cutting Topics](#9-cross-cutting-topics)
10. [Comparative Analysis](#10-comparative-analysis)
11. [Relevance to Zylos](#11-relevance-to-zylos)

---

## 1. Executive Summary

The AI agent memory landscape has matured rapidly in 2025-2026. The field has converged on several key insights:

- **Memory tiering is essential**: All successful systems separate short-term (in-context), medium-term (session summaries), and long-term (persistent facts/knowledge) storage.
- **Graph-based memory is gaining traction**: Zep's temporal knowledge graphs and Mem0's graph memory outperform flat vector-only approaches on relational reasoning.
- **Filesystem-based approaches are surprisingly competitive**: Letta's benchmark showed a simple filesystem agent scoring 74% on memory tasks, beating specialized memory libraries.
- **Structured summarization outperforms freeform**: Structured summaries with dedicated sections prevent silent information loss.
- **The "remember everything" vs "remember what matters" debate persists**: Automation-first (claude-mem, Mem0) vs human-curated (Zylos) remains a fundamental design choice.

### Top-Level Comparison

| Solution | Architecture | Memory Type | Best For | Complexity |
|----------|-------------|-------------|----------|------------|
| MemGPT/Letta | OS-inspired virtual context | Core/Archival/Recall tiers | Stateful agents with self-editing memory | Medium-High |
| claude-mem | Hook-based auto-capture | SQLite + ChromaDB vectors | Claude Code users wanting zero-effort memory | Medium |
| Mem0 | Vector + Graph hybrid | Episodic/Semantic/Procedural | Multi-user AI applications at scale | Medium-High |
| Zep | Temporal knowledge graph | Episode/Entity/Community subgraphs | Conversational agents needing temporal reasoning | High |
| LangChain/LangGraph | Framework-native persistence | Short-term/Long-term stores | Agents built within LangChain ecosystem | Medium |
| OpenAI Memory | Cloud-native extraction | User profile + chat history | ChatGPT users (closed system) | Low (managed) |
| Zylos (current) | File-based + SQLite FTS5 | Markdown files + KB entries | CLI agent, transparency, git-tracked | Low |

---

## 2. MemGPT / Letta

### Overview

MemGPT (now Letta) pioneered the concept of treating LLM context windows like operating system memory. The core insight: just as an OS provides virtual memory by paging data between RAM and disk, an LLM agent can manage "virtual context" by moving information between the limited context window and external storage.

**GitHub:** 40k+ stars (letta-ai/letta)
**Status:** Production framework, raised $10M, Letta V1 architecture released

### Architecture

```
LLM Context Window ("Main Memory / RAM")
  |-- System Prompt (fixed instructions)
  |-- Core Memory (self-editable persona + user info)
  |-- Recent Messages (conversation buffer)
  |-- Working Context (current task state)

External Storage ("Disk")
  |-- Archival Memory (vector DB: Chroma, pgvector)
  |-- Recall Memory (searchable conversation history)
```

### Memory Components

**Core Memory (always in-context):**
- Split into `persona` (agent's self-description) and `human` (user info)
- Agent can self-edit both blocks using `core_memory_append` and `core_memory_replace`
- Limited size (configurable, e.g., 2000 characters per block)
- Acts as "working memory" that evolves with each interaction

**Archival Memory (external, vector-indexed):**
- Long-term storage backed by vector database
- Agent writes important information using `archival_memory_insert`
- Retrieves via `archival_memory_search` with semantic similarity
- No size limit; analogous to disk storage

**Recall Memory (external, searchable):**
- Complete conversation history stored in database
- Searchable by keyword, date, or semantic similarity
- Used to reconstruct past interactions when needed

### Context Overflow Management

When the context window approaches capacity (e.g., 70% of token limit):
1. System warns the agent of impending eviction
2. Agent can choose to save important information to archival/core memory
3. Oldest messages are evicted and recursively summarized
4. Summaries replace original messages in the conversation buffer

### Letta V1 Evolution (2025-2026)

- Deprecated "heartbeat" mechanism (inner monologue loops)
- Added Conversations API for shared memory across parallel user sessions
- Introduced Letta Filesystem for document organization (PDFs, transcripts, etc.)
- Letta Code: memory-first coding agent, #1 on Terminal-Bench

### Strengths

- Agent-driven memory management (LLM decides what to save/retrieve)
- Self-editing memory allows personality and knowledge evolution
- Elegant OS analogy provides clear mental model
- Strong benchmark results: Letta Filesystem scored 74% on LoCoMo by just using files
- Active development, strong community

### Weaknesses

- Complexity: requires server, database, agent framework
- Token overhead: memory management function calls consume context
- Agent reliability: LLM may make poor save/retrieve decisions
- V1 architecture is still evolving, breaking changes

### Relevance to Zylos

**High relevance.** The core memory concept (small, always-present, self-editable blocks) maps directly to Zylos's `memory/*.md` files. The key difference: MemGPT automates the save/retrieve decisions, while Zylos relies on Claude's judgment guided by CLAUDE.md instructions. Letta's filesystem benchmark (74% with just files) validates that Zylos's file-based approach is fundamentally sound.

---

## 3. claude-mem

### Overview

Community-built memory system specifically for Claude Code. Uses lifecycle hooks to automatically capture and compress interactions into a searchable database.

**GitHub:** 17.7k stars (thedotmack/claude-mem)
**Status:** Active community project

### Architecture

```
Claude Code Session
  --> 5 Lifecycle Hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd)
      --> claude-mem Worker (port 37777, Bun runtime)
          --> SQLite (FTS5) for text search
          --> ChromaDB for vector/semantic search
          --> MCP Tools for retrieval
```

### Key Features

- **Automatic capture**: Every tool use, file change, and user prompt recorded
- **AI compression**: Worker extracts "learnings" and generates summaries
- **3-layer retrieval**: Index -> Timeline -> Full detail (10x token savings)
- **Web UI**: Real-time memory stream viewer
- **Privacy tags**: `<private>` excludes content from storage

### Detailed Analysis

See existing comparison: `~/zylos/learning/2026-02-03-claude-mem-vs-zylos-comparison.md`

### Relevance to Zylos

**Medium relevance.** claude-mem validates the value of hook-based capture for Claude Code. However, its "capture everything" philosophy conflicts with Zylos's "remember what matters" approach. Selective adoption of specific hooks (e.g., SessionEnd summary) is more appropriate than wholesale adoption.

---

## 4. Mem0

### Overview

Mem0 is a scalable memory layer that sits between AI applications and LLMs, automatically extracting, consolidating, and retrieving information from conversations. It supports both vector-based and graph-based memory.

**GitHub:** 25k+ stars (mem0ai/mem0)
**Funding:** $24M raised (Oct 2025, YC, Peak XV, Basis Set)
**Status:** Production service, cloud API + self-hosted option

### Architecture

```
Application / Agent
    |
    v
Mem0 Memory Layer
    |-- Memory Extraction (LLM-based entity/fact extraction)
    |-- Vector Store (embeddings for semantic search)
    |-- Graph Store (Mem0g: entities + relationships)
    |-- Conflict Detection & Resolution
    |
    v
Storage Backends
    |-- Vector: Qdrant, Pinecone, ChromaDB, pgvector
    |-- Graph: Neo4j, Amazon Neptune
    |-- Cache: Redis, ElastiCache
```

### Memory Types

| Type | Description | Example |
|------|-------------|---------|
| **Episodic** | Summaries of past interactions/tasks | "User debugged a Python timeout issue on Jan 5" |
| **Semantic** | Relationships between concepts | "User prefers TypeScript over JavaScript" |
| **Procedural** | How to perform tasks | "Deploy process: build -> test -> push -> verify" |
| **Associative** | Cross-references between memories | Links between related facts/events |

### Memory Scopes

- **User Memory**: Persists across all conversations with a specific person
- **Session Memory**: Context within a single conversation
- **Agent Memory**: Information specific to a particular AI agent instance

### Graph Memory (Mem0g)

Mem0g extends the base system with a knowledge graph layer:
1. **Entity Extraction**: LLM identifies people, locations, concepts, events from conversation
2. **Relationship Generation**: Establishes directed labeled edges between entities
3. **Conflict Resolution**: Detects contradictions with existing memories, resolves via recency/confidence
4. **Hybrid Retrieval**: Combines vector similarity search with graph traversal for richer context

### Performance

- 26% improvement over OpenAI's memory on LLM-as-a-Judge metric
- 91% lower p95 latency vs baseline
- 90%+ token cost savings through selective retrieval
- Serves as exclusive memory provider for AWS Agent SDK

### Strengths

- Production-ready with cloud API
- Flexible storage backends (bring your own vector/graph DB)
- Graph memory captures relational knowledge that vector-only misses
- Well-funded with strong enterprise adoption
- Works with any LLM provider

### Weaknesses

- Complexity: requires external services (vector DB, graph DB, LLM for extraction)
- Extraction quality depends on LLM capability
- Cloud dependency for managed service
- Graph memory adds latency vs pure vector search
- Overkill for single-user CLI agents

### Relevance to Zylos

**Medium relevance.** Mem0's memory type taxonomy (episodic/semantic/procedural) provides a useful framework for organizing Zylos's memory files. The graph memory concept could enhance the KB's ability to surface related knowledge. However, Mem0's full architecture is over-engineered for a single-user CLI agent. The extraction patterns (entity/relationship extraction from conversations) could be adopted as lightweight hooks.

---

## 5. Zep

### Overview

Zep is a temporal knowledge graph architecture for agent memory, built on Graphiti -- a temporally-aware knowledge graph engine. It outperforms MemGPT on the Deep Memory Retrieval benchmark while using 98% fewer tokens.

**GitHub:** getzep/zep, getzep/graphiti
**Paper:** arXiv:2501.13956 (Jan 2025)
**Status:** Open-source + commercial, integrated with Amazon Neptune

### Architecture: Three-Tier Subgraph

```
Graphiti Knowledge Graph
  |
  |-- Episode Subgraph (raw data layer)
  |     |-- Episode nodes: raw messages, JSON, transcripts
  |     |-- Timestamped with original event time
  |     |-- Non-lossy ground truth corpus
  |
  |-- Semantic Entity Subgraph (extracted knowledge)
  |     |-- Entity nodes with 1024D embeddings
  |     |-- Relationship edges between entities
  |     |-- Bidirectional links to source episodes
  |     |-- Semantic similarity via cosine distance
  |
  |-- Community Subgraph (aggregated understanding)
        |-- Community detection via label propagation
        |-- Summarized clusters of related entities
        |-- Enables high-level reasoning about topics
```

### Key Design Principles

**Non-Lossy Architecture:**
- Episodes (raw inputs) are never discarded
- Semantic entities maintain bidirectional links to source episodes
- Any extracted fact can be traced back to its original context
- Enables citation and verification

**Temporal Awareness:**
- Every fact and relationship has a validity period
- Knowledge graph updates dynamically as new information arrives
- Handles contradictory facts by tracking temporal validity
- "User lived in NYC" (2020-2023) vs "User lives in London" (2023-present)

**Community Detection:**
- Uses label propagation algorithm (not Leiden)
- Dynamically extensible as new data enters
- Delays need for complete community refreshes
- Enables topic-level reasoning ("What does the user know about Python?")

### Performance

- Up to 18.5% accuracy improvement over baselines
- 90% latency reduction
- Uses less than 2% of baseline tokens
- State-of-the-art on Deep Memory Retrieval benchmark

### Strengths

- Temporal awareness is unique and powerful
- Non-lossy design preserves raw data for verification
- Three-tier architecture balances detail vs abstraction
- Strong benchmark results with minimal token usage
- Open-source core (Graphiti)

### Weaknesses

- Requires Neo4j or Neptune (graph database dependency)
- Complex infrastructure for self-hosting
- Graph construction has latency cost
- Community detection adds computational overhead
- Primarily designed for conversational agents, not CLI workflows

### Relevance to Zylos

**Medium-High relevance.** Zep's temporal awareness is directly relevant to Zylos's need to track evolving decisions and project states. The non-lossy principle (never discard raw data) aligns with git-tracked memory files. The three-tier approach (raw episodes, extracted entities, community summaries) could inspire a structured approach to Zylos's memory organization. However, the full graph database infrastructure is too heavy for our use case.

---

## 6. LangChain / LangGraph Memory

### Overview

LangGraph provides framework-native memory as part of the agent orchestration layer, with the recently released LangMem SDK adding specialized long-term memory capabilities.

**Status:** LangGraph 1.0 released (2025), LangMem SDK launched

### Architecture

```
LangGraph Agent
  |
  |-- Short-term Memory (Checkpointer)
  |     |-- Message history within a thread
  |     |-- Persisted via SQLite, PostgreSQL, etc.
  |     |-- Resume any conversation at any point
  |
  |-- Long-term Memory (BaseStore)
  |     |-- Cross-session, cross-thread storage
  |     |-- Namespaced key-value store
  |     |-- Scoped to user, agent, or application
  |     |-- MongoDB Store, PostgreSQL Store, etc.
  |
  |-- LangMem SDK (specialized memory layer)
        |-- Semantic Memory (facts about users/domains)
        |-- Episodic Memory (past interaction examples)
        |-- Procedural Memory (learned instructions)
```

### LangMem Memory Types

**Semantic Memory:**
- Facts about users or domains
- Two representations: Collections (unbounded, searchable) and Profiles (schema-constrained, easy lookup)
- Example: "User prefers dark mode" stored in user profile

**Episodic Memory:**
- Memories of specific past interactions
- Distilled from longer raw interactions into few-shot examples
- Answers "how did we solve this before?" rather than "what is X?"

**Procedural Memory:**
- Internalized knowledge of how to perform tasks
- Saved as updated instructions in the agent's prompt
- Agent literally rewrites its own system prompt based on learned procedures

### Key Features

- **Background Memory Manager**: Automatically extracts, consolidates, and updates memories
- **Memory Tools**: Agents can invoke memory read/write during conversations
- **Native LangGraph Integration**: Memories accessed via store within graph nodes
- **DeepLearning.AI Course**: "Long-Term Agentic Memory with LangGraph" (Harrison Chase)

### Strengths

- Tight framework integration (if already using LangGraph)
- Clean separation of memory types
- Procedural memory (prompt self-modification) is unique
- Active development, strong ecosystem
- MongoDB Store for scalable long-term memory

### Weaknesses

- Framework lock-in (LangGraph-specific)
- Relatively new (LangMem launched early 2025)
- Less battle-tested than Mem0 or Zep
- Requires LangGraph agent architecture

### Relevance to Zylos

**Low-Medium relevance.** The memory type taxonomy (semantic/episodic/procedural) is useful conceptually but LangGraph is a framework-level solution. Zylos operates at the CLI/file level, not within an agent framework. The procedural memory concept (agent rewrites its own prompt) is interesting and somewhat analogous to how CLAUDE.md evolves, but the implementation approach differs fundamentally. The LangMem background memory manager pattern could inspire automated memory consolidation in Zylos.

---

## 7. OpenAI's Built-in Memory

### Overview

ChatGPT's memory system represents the most widely deployed AI memory solution, serving hundreds of millions of users. As of April 2025, it combines explicit saved memories with automatic chat history reference.

**Status:** Production (ChatGPT Plus/Team/Enterprise), significantly upgraded April 2025

### Architecture

```
ChatGPT Session
  |
  |-- Saved Memories (explicit)
  |     |-- User-requested facts ("Remember that I'm vegetarian")
  |     |-- Auto-extracted preferences and facts
  |     |-- Stored in user profile, not tied to specific chats
  |
  |-- Chat History Reference (implicit, since April 2025)
  |     |-- Embedding-based retrieval from all past conversations
  |     |-- Semantic search: user query -> embedding -> top-k retrieval
  |     |-- Summarization pipeline for long histories
  |
  |-- Entity Extraction Pipeline
        |-- Extracts stable facts: names, preferences, roles, tools
        |-- Structured storage in user profile
        |-- Contradiction detection with existing memories
```

### Key Design Decisions

**Dual Memory System:**
- Explicit memories: User says "remember X" or model detects important facts
- Implicit history: All past chats are embedding-indexed and retrievable
- Memories persist even when chats are deleted (separate storage)

**User Control:**
- View all memories in settings
- Delete individual memories or clear all
- Turn memory off entirely
- Tell ChatGPT to forget specific things conversationally

**April 2025 Upgrade:**
- Chat history now actively referenced in all conversations
- Not just saved memories, but full historical context
- Dramatically improved personalization and continuity

### Strengths

- Seamless UX (zero user effort for basic memory)
- Massive scale validation (hundreds of millions of users)
- Good balance of automation and user control
- Continuous improvement (April 2025 upgrade was significant)

### Weaknesses

- Closed system (no self-hosting, no API access to memory)
- Opaque extraction (users can't see what was extracted from history)
- No version control or rollback
- Privacy concerns (all conversations stored and indexed)
- Memory quality varies (extraction is imperfect)
- No user-controlled schema or structure

### Relevance to Zylos

**Low relevance for direct adoption** (closed system), but **High conceptual relevance:**
- The dual memory pattern (explicit saves + implicit history search) could inspire a hybrid approach in Zylos
- Entity extraction pipeline demonstrates value of automatic fact extraction
- User control model (view, delete, disable) is a good UX reference
- The April 2025 upgrade validates that referencing full conversation history improves AI quality

---

## 8. Academic Research (2025-2026)

### 8.1 "Memory in the Age of AI Agents" Survey (Dec 2025)

**Authors:** Shichun Liu et al.
**ArXiv:** 2512.13564 (updated Jan 2026)
**Impact:** Comprehensive survey with 150+ referenced papers, ICLR 2026 workshop

#### Memory Taxonomy

The survey proposes the most rigorous taxonomy to date:

**By Form (how memory is stored):**
| Form | Description | Example |
|------|-------------|---------|
| Token-level | Information stored as text tokens in context | Conversation history, CLAUDE.md |
| Parametric | Information encoded in model weights | Fine-tuning, RLHF |
| Latent | Information in learned representations | Hidden states, embeddings |

**By Function (what memory does):**
| Function | Description | Zylos Equivalent |
|----------|-------------|------------------|
| Factual | Declarative knowledge: user profiles, environmental states | preferences.md, context.md |
| Experiential | Procedural knowledge: how to solve problems | decisions.md, KB entries |
| Working | Short-term task-specific state | Current conversation context |

**Experiential Memory Sub-types:**
- **Case-based**: Raw trajectories for replay ("last time we did X...")
- **Strategy-based**: Abstracted workflows and insights
- **Skill-based**: Executable code or tool APIs (most concrete)

#### Key Findings

1. **Memory automation is a frontier**: Moving from manual to automatic memory management without losing quality
2. **RL integration**: Using reinforcement learning to optimize what/when/how to memorize
3. **Multimodal memory**: Extending beyond text to images, code, structured data
4. **Multi-agent memory**: Shared memory architectures for agent teams
5. **Trustworthiness**: Ensuring memory doesn't introduce hallucinations or bias

### 8.2 A-MEM: Agentic Memory for LLM Agents (NeurIPS 2025)

**Authors:** Wujiang Xu et al.
**ArXiv:** 2502.12110

#### Core Innovation

A-MEM applies the **Zettelkasten method** (a note-taking system for interconnected knowledge) to AI agent memory. Key principles:
- Each memory is a structured note with contextual descriptions, keywords, and tags
- Memories are dynamically linked to form interconnected knowledge networks
- Memory evolution: new memories trigger updates to existing memories
- All organization decisions made by the agent (LLM), not hardcoded rules

#### Performance

- Doubles performance on complex multi-hop reasoning tasks
- Cost-effective: no external vector DB or graph DB required
- Self-organizing: agent manages its own memory structure

#### Relevance to Zylos

**High relevance.** A-MEM's Zettelkasten approach is strikingly similar to how Zylos KB entries work (tagged, categorized, searchable). The key insight is dynamic linking and memory evolution -- when new knowledge is saved, existing related entries should be updated or cross-referenced. This could enhance Zylos's KB with automatic cross-referencing.

### 8.3 ICLR 2026 Workshop: MemAgents

A dedicated workshop on "Memory for LLM-Based Agentic Systems" accepted at ICLR 2026, indicating the field considers agent memory a critical open problem deserving focused research attention.

### 8.4 ACM Transactions Survey on LLM Agent Memory Mechanisms

Published in ACM Transactions on Information Systems (2025), providing another comprehensive review focused on memory mechanism taxonomy and evaluation protocols.

---

## 9. Cross-Cutting Topics

### 9.1 Memory Tiering Best Practices

All surveyed systems converge on a tiered architecture. The consensus hierarchy:

```
Tier 1: In-Context (Hot)
  - System prompt, core facts, current task state
  - Always present, highest priority
  - Size: limited by context window

Tier 2: Session Memory (Warm)
  - Recent conversation history
  - Summarized on overflow
  - Size: configurable buffer

Tier 3: Long-Term Memory (Cool)
  - Persistent facts, user profiles, learned skills
  - Retrieved on-demand via search
  - Size: unbounded

Tier 4: Archival (Cold)
  - Raw conversation logs, old session transcripts
  - Rarely accessed, preserved for reference
  - Size: unbounded
```

**Best Practice:** Allocate more context budget to Tier 1 while including relevant summaries and facts from lower tiers via retrieval.

### 9.2 Automatic Summarization Techniques

**Hierarchy of approaches (prefer in order):**

1. **Raw context** (no summarization): Use when context fits
2. **Compaction** (reversible): Strip redundant information that exists in the environment (e.g., file contents that can be re-read). Preferred because it's lossless.
3. **Structured summarization**: Summarize with dedicated sections for different information types (decisions, file paths, task state). Forces preservation of key categories.
4. **Freeform summarization**: Last resort. Risk of silent information loss.

**Structured Summarization Template (from Factory.ai research):**

```
## Current Task State
[Active task description and progress]

## Key Decisions Made
[Numbered list of decisions with rationale]

## Files Modified
[List of file paths with change descriptions]

## Open Questions
[Unresolved items]

## User Preferences Observed
[New preferences noted in this session]
```

**Key Insight:** Structure forces preservation. Each section acts as a checklist that the summarizer must populate or explicitly leave empty, preventing gradual information loss.

### 9.3 Semantic Retrieval Strategies

**Vector Search (most common):**
- Embed memories using embedding model (OpenAI, local)
- Cosine similarity for retrieval
- Good for: finding semantically related memories
- Weakness: misses structural/relational information

**Graph Traversal (Zep, Mem0g):**
- Store entities and relationships in graph database
- Traverse connections to find related context
- Good for: multi-hop reasoning, relational queries
- Weakness: infrastructure complexity

**Hybrid (emerging best practice):**
- Vector search narrows candidate set
- Graph traversal enriches with relational context
- Best of both: semantic relevance + structural relationships

**FTS5 (Zylos's current approach):**
- Full-text search with SQLite
- Fast, simple, no external dependencies
- Good for: keyword-based retrieval, exact matches
- Weakness: no semantic understanding

### 9.4 Graceful Context Compaction Patterns

**Pre-Rot Threshold Strategy:**
- Define threshold based on model capabilities (e.g., 70% of context window)
- Begin compaction BEFORE hitting the limit
- Preserves reasoning quality (performance degrades in the "rot zone")

**Sliding Window with Summarization:**
- Keep N most recent messages in full
- Summarize older messages in progressively coarser detail
- Maintain a running summary that gets updated each time the window slides

**Selective Preservation:**
- Always keep: system prompt, core memory blocks, current task state
- Summarize: completed tasks, resolved discussions
- Drop: tool outputs that can be regenerated (file reads, command outputs)
- Never drop: user decisions, error resolutions, learned preferences

**Compaction API (Anthropic, 2026):**
- Server-side context summarization (beta on Opus 4.6)
- Enables "effectively infinite conversations"
- Reduces client-side complexity

---

## 10. Comparative Analysis

### 10.1 Architecture Comparison

| Solution | Storage | Search | Graph | Temporal | Self-Hosting |
|----------|---------|--------|-------|----------|-------------|
| MemGPT/Letta | Vector DB | Semantic | No | No | Yes |
| claude-mem | SQLite + ChromaDB | FTS5 + Semantic | No | No | Yes |
| Mem0 | Vector + Graph DB | Semantic + Graph | Yes (Mem0g) | Limited | Yes + Cloud |
| Zep | Knowledge Graph | Semantic + Graph | Yes (core) | Yes (core) | Yes + Cloud |
| LangGraph | Checkpointer + Store | Namespace lookup | No | No | Yes |
| OpenAI | Proprietary | Embedding search | Unknown | No | No |
| **Zylos** | **Files + SQLite** | **FTS5** | **No** | **Via git** | **Yes** |

### 10.2 Memory Type Coverage

| Solution | Factual | Episodic | Procedural | Working | Self-Editing |
|----------|---------|----------|------------|---------|-------------|
| MemGPT/Letta | Yes (core) | Yes (recall) | No | Yes | Yes |
| claude-mem | Yes | Yes | No | No | No |
| Mem0 | Yes | Yes | Yes | No | No |
| Zep | Yes (entity) | Yes (episode) | No | No | No |
| LangMem | Yes (semantic) | Yes (episodic) | Yes (procedural) | No | Yes (prompt) |
| OpenAI | Yes (profile) | Yes (history) | No | Yes | No |
| **Zylos** | **Yes (prefs)** | **Partial (context)** | **Partial (decisions)** | **Yes** | **Yes (CLAUDE.md)** |

### 10.3 Suitability for Zylos Use Case

Our use case: CLI-based AI agent (Claude Code), running in tmux, file-based memory with git tracking, SQLite FTS5 KB, single user, needs transparency and simplicity.

| Solution | Fit Score | Reason |
|----------|-----------|--------|
| MemGPT/Letta | 6/10 | Good concepts but too much infrastructure |
| claude-mem | 5/10 | Claude-specific but philosophy mismatch |
| Mem0 | 4/10 | Over-engineered for single-user CLI |
| Zep | 5/10 | Great concepts but heavy infrastructure |
| LangGraph | 3/10 | Framework lock-in, different paradigm |
| OpenAI | 2/10 | Closed system, not applicable |
| A-MEM (academic) | 7/10 | Zettelkasten approach aligns with KB |

---

## 11. Relevance to Zylos

### 11.1 What Zylos Already Does Well

Based on the industry survey, Zylos's current approach has several validated strengths:

1. **File-based storage is competitive**: Letta's benchmark (74% with filesystem) validates that files are a sound foundation
2. **Git tracking is unique**: No other solution offers built-in version control with rollback
3. **Human-curated quality**: The "remember what matters" approach produces higher signal-to-noise than automated capture
4. **Simplicity**: No external services, databases, or runtime dependencies
5. **Transparency**: Every memory is human-readable and editable
6. **Self-editing memory**: Claude already updates CLAUDE.md and memory files, similar to MemGPT's core memory

### 11.2 Gaps Identified

| Gap | Industry Solution | Potential Zylos Improvement |
|-----|-------------------|---------------------------|
| No semantic search on memory files | Mem0, claude-mem vector search | Index memory/*.md in KB with embeddings |
| Manual-only memory updates | MemGPT auto-save, claude-mem hooks | Selective auto-capture via hooks (SessionEnd summary) |
| No structured compaction | Factory.ai structured summarization | Implement structured compaction template |
| No cross-referencing between memories | A-MEM Zettelkasten, Zep graph | Add KB cross-references and tags |
| No temporal tracking of facts | Zep temporal knowledge graph | Timestamp entries in decisions.md |
| No episodic memory (session logs) | LangMem episodic, Zep episodes | Auto-generate session summaries |
| Single retrieval method (FTS5) | Mem0 hybrid, Zep multi-tier | Add embedding-based search alongside FTS5 |
| No memory type differentiation | Mem0/LangMem taxonomy | Organize KB by memory type (factual/experiential/procedural) |

### 11.3 Recommended Improvements (Prioritized)

**Priority 1 -- Low Effort, High Impact:**

1. **Structured compaction template**: Replace freeform summarization during context compaction with a structured template that forces preservation of key categories (task state, decisions, files, preferences). This addresses the most common failure mode (losing information during compaction).

2. **Session-end summary hook**: Add a SessionEnd or Stop hook that auto-appends a brief structured summary to `context.md`. This captures session continuity without full automation overhead.

3. **Timestamp decisions**: Add ISO timestamps to entries in `decisions.md` to enable temporal reasoning about when decisions were made and how they evolved.

**Priority 2 -- Medium Effort, High Impact:**

4. **Embed memory files in KB**: Index `memory/*.md` content in the knowledge base with embeddings, enabling semantic search across both structured KB entries and freeform memory files.

5. **KB cross-referencing**: When saving new KB entries, automatically search for and link to related existing entries (A-MEM Zettelkasten pattern). Add a `related_entries` field to KB schema.

6. **Memory type tags for KB**: Categorize KB entries using the academic taxonomy: factual, experiential (case-based, strategy-based, skill-based), procedural. Enables type-aware retrieval.

**Priority 3 -- Higher Effort, Strategic Value:**

7. **Tiered memory architecture**: Formalize the memory tiers:
   - Tier 1 (Hot): CLAUDE.md + core memory blocks (always in context)
   - Tier 2 (Warm): Recent context.md + active project state
   - Tier 3 (Cool): KB entries (retrieved on demand via search)
   - Tier 4 (Cold): Git history (accessed only for rollback/audit)

8. **Selective auto-capture via PostToolUse hook**: Detect significant events (git commits, file writes to certain paths, decision-related keywords) and auto-append to appropriate memory files.

9. **Progressive disclosure for SessionStart**: Instead of loading all memory files at session start, load an index/summary first, then retrieve full content on demand. Reduces initial context consumption.

### 11.4 What NOT to Adopt

1. **Full graph database (Neo4j, Neptune)**: Overkill for single-user CLI agent
2. **External vector database (ChromaDB, Qdrant)**: SQLite FTS5 + KB embeddings are sufficient at our scale
3. **Worker service architecture**: Adds failure points without proportional benefit
4. **Full conversation capture**: High noise, conflicts with curated approach
5. **Framework lock-in (LangGraph, Letta)**: Zylos benefits from framework independence
6. **MCP-based memory tools**: File reads are simpler and more reliable

---

## Sources

### Primary Sources (Projects & Documentation)

- [MemGPT / Letta Documentation](https://docs.letta.com/concepts/memgpt/)
- [Letta GitHub](https://github.com/letta-ai/letta)
- [Letta V1 Agent Architecture](https://www.letta.com/blog/letta-v1-agent)
- [Letta Code: Memory-First Coding Agent](https://www.letta.com/blog/letta-code)
- [Benchmarking AI Agent Memory: Is a Filesystem All You Need?](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- [Agent Memory: How to Build Agents that Learn and Remember](https://www.letta.com/blog/agent-memory)
- [Mem0 Documentation](https://docs.mem0.ai/)
- [Mem0 GitHub](https://github.com/mem0ai/mem0)
- [Mem0 Graph Memory](https://docs.mem0.ai/open-source/features/graph-memory)
- [Mem0 Memory Types](https://docs.mem0.ai/core-concepts/memory-types)
- [Mem0 Research: 26% Accuracy Boost](https://mem0.ai/research)
- [Zep Documentation](https://www.getzep.com/)
- [Zep GitHub](https://github.com/getzep/zep)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [LangGraph Memory Overview](https://docs.langchain.com/oss/python/langgraph/memory)
- [LangMem SDK Launch](https://blog.langchain.com/langmem-sdk-launch/)
- [LangMem Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- [OpenAI Memory Announcement](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [claude-mem GitHub](https://github.com/thedotmack/claude-mem)

### Academic Papers

- [MemGPT: Towards LLMs as Operating Systems (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (arXiv:2504.19413)](https://arxiv.org/abs/2504.19413)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv:2501.13956)](https://arxiv.org/abs/2501.13956)
- [Memory in the Age of AI Agents: A Survey (arXiv:2512.13564)](https://arxiv.org/abs/2512.13564)
- [A-MEM: Agentic Memory for LLM Agents (arXiv:2502.12110, NeurIPS 2025)](https://arxiv.org/abs/2502.12110)
- [A Survey on the Memory Mechanism of LLM-based Agents (ACM TOIS 2025)](https://dl.acm.org/doi/10.1145/3748302)
- [ICLR 2026 Workshop: MemAgents](https://openreview.net/pdf?id=U51WxL382H)

### Industry Analysis & Best Practices

- [Memory Optimization Strategies in AI Agents (Medium)](https://medium.com/@nirdiamant21/memory-optimization-strategies-in-ai-agents-1f75f8180d54)
- [Cutting Through the Noise: Smarter Context Management (JetBrains)](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
- [Evaluating Context Compression for AI Agents (Factory.ai)](https://factory.ai/news/evaluating-compression)
- [Context Engineering for AI Agents: Part 2 (Philipp Schmid)](https://www.philschmid.de/context-engineering-part-2)
- [Claude Code Best Practices: Memory Management](https://cuong.io/blog/2025/06/15-claude-code-best-practices-memory-management/)
- [Mem0 raises $24M (TechCrunch)](https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/)
- [Best AI Memory Systems Review (Pieces.app)](https://pieces.app/blog/best-ai-memory-systems)
- [Existing Zylos Analysis: claude-mem vs Zylos Comparison](~/zylos/learning/2026-02-03-claude-mem-vs-zylos-comparison.md)
