# Multi-Session Architecture

Draft proposal for concurrent session support in zylos-core.

Status: **discussion** — design not finalized.

## Problem

A single Claude Code session processes all inputs serially: scheduled tasks, bot-to-bot messages, user conversations, and long-running operations share one context window. This creates three problems:

1. **Throughput**: a long task (deploy, code review) blocks the user from starting a separate conversation.
2. **Context pollution**: task noise (heartbeats, scheduled jobs, bot chatter) dilutes the context available for deep thinking.
3. **User-side interference**: on the user's channel, all topics interleave in one chat, making it hard to follow any single thread.

## Design

### Layers

```
┌─────────────────────────────────────────────┐
│  Channel Components (TG, Lark, Web, ...)    │  UX adaptation per platform
├─────────────────────────────────────────────┤
│  C4 Communication Bridge                    │  Thread capability negotiation
├─────────────────────────────────────────────┤
│  Session Supervisor                         │  Routing, lifecycle, pool mgmt
├─────────────────────────────────────────────┤
│  Session Workers (Claude Code instances)    │  Independent context windows
├─────────────────────────────────────────────┤
│  Context Store (per-session SQLite)         │  Information projection + persistence
├─────────────────────────────────────────────┤
│  Shared State (memory/, components/, .env)  │  Filesystem-level sharing (main agent)
└─────────────────────────────────────────────┘
```

### Session Supervisor

A lightweight Node.js process (not an LLM session) that manages the session pool.

Responsibilities:
- **Lifecycle**: spawn, list, attach, detach, kill sessions
- **Routing**: decide which session handles an incoming message
- **Health**: unified AM for all sessions — heartbeat, crash recovery, restart
- **Resource**: enforce concurrency limits based on system resources
- **Hook injection**: auto-configure dashboard hooks per session on spawn
- **Context rotation**: monitor context usage, trigger memory sync + session replacement when near threshold

The supervisor does NOT hold conversation context. It is a thin control plane.

### Session Workers

Each worker is an independent Claude Code process with its own context window.

Properties:
- `id`: unique identifier (e.g., `sess_a1b2c3`)
- `purpose`: human-readable tag (e.g., "deploy-dashboard", "howard-chat", "research-livekit")
- `capability`: `full` | `internal` | `sandbox`
- `status`: idle / busy / waiting_for_input
- `context_usage`: percentage of context window consumed
- `created_at`: timestamp
- `last_activity_at`: timestamp
- `channel_bindings`: which channel threads are routed to this session

### Capability Levels

| Level | Memory | Components | Secrets | Use case |
|-------|--------|------------|---------|----------|
| `full` | read/write all | all | all | Main agent, primary session |
| `internal` | read/write all | all | all | Ops, research, deep thinking |
| `sandbox` | read projected subset | declared list | none | External-facing, customer support |

Sandbox sessions receive a **projected** subset of information (see Information Architecture below), not direct filesystem access.

### Routing

When a message arrives at C4, the supervisor decides where to send it:

```
message arrives
    │
    ├─ has explicit session target (@session-name, thread binding)?
    │   └─ yes → route to that session
    │
    ├─ is a system message (heartbeat, scheduled task)?
    │   └─ yes → route to ops session (auto-spawn if needed)
    │
    └─ user message, no explicit target
        └─ LLM classifier (haiku-tier) analyzes:
           - message content
           - active sessions and their purposes
           - recent conversation context per session
           → route to best-matching session, or spawn new
```

The LLM classifier is a single fast call (~100ms, minimal tokens) that returns a session_id or "spawn_new" with a suggested purpose tag.

### Channel Thread Mapping

Channels declare a capability level for thread/topic support:

```json
{
  "thread_support": "native" | "simulated" | "none"
}
```

| Level | Behavior | Examples |
|-------|----------|---------|
| `native` | Channel creates real threads/topics per session | TG Topics, Lark threads, Slack channels |
| `simulated` | Messages prefixed with `[session-name]` | TG DM, basic Lark DM |
| `none` | All messages in one stream, no session visibility | SMS, email |

Channel component interface additions:

```
createThread(sessionId: string, title: string) → threadId
routeToThread(threadId: string, message: string) → void
getThreadCapability() → "native" | "simulated" | "none"
```

For `native` channels, the user experience is seamless — each session is a separate conversation space. For `simulated`, messages carry a prefix tag. For `none`, routing is invisible to the user (supervisor handles it internally).

## Information Architecture

### Information Asset Classification

Memory and skill files carry a sensitivity level:

| Level | Examples | Sandbox access |
|-------|----------|----------------|
| `public` | reference/projects.md (status), skill SKILL.md descriptions | yes |
| `internal` | reference/decisions.md, reference/preferences.md | no |
| `private` | users/howard/profile.md, .env, SSH keys, API tokens | no |
| `confidential` | identity.md full version, raw conversation transcripts | no |

Classification is declared in a manifest file (`access-control.json`) mapping path patterns to levels, not embedded in individual files.

### Context Projection

When spawning a sandbox session, the supervisor (or a dedicated LLM call) performs **context projection**: extracting only the information the sub-agent needs and is allowed to see, based on its purpose and capability level.

This is not file-level filtering — it is content-level extraction. The same `decisions.md` may contain 10 decisions; 3 relevant to a customer project are projected into the sandbox, while 7 involving internal matters are excluded.

The projection is written to the session's context store, not passed as raw files.

### Context Store (Per-Session)

Each session has its own SQLite-based context store:

```
~/zylos/sessions/<session_id>/
├── workspace/       # File output (sandboxed working directory)
├── context.db       # Context store — injected info + session-generated knowledge
└── meta.json        # Session metadata (purpose, capability, bindings)
```

The context store supports three operations:

**inject** (main → sub): Add information to a session's available context.
```
supervisor.inject(session_id, { key, content, scope })
```

**revoke** (main → sub): Remove information from a session's available context. Because the store is external (not in the LLM's context window), revoke is a true deletion — no residual information in the session's memory.
```
supervisor.revoke(session_id, { scope })
```

**write** (sub → store): Session writes structured knowledge it has learned.
```
store.write(session_id, { key, content, scope })
```

Sub-agent information access is pull-based (RAG-style query against the store), not push-based (injected into context window). This ensures revoke is effective — revoked information is simply absent from future queries.

### Data Flow Control

```
Main Agent Memory ──inject──→ Context Store ──query──→ Sub-Agent
                                    ↑
                              write │
                                    │
                              Sub-Agent (new knowledge)
                                    │
                              promote (requires approval)
                                    │
                                    ↓
                         Main Agent Memory
```

- **Main → Sub**: inject (controlled, projected)
- **Sub → Store**: write (local to session)
- **Store → Main**: promote (requires main agent or owner approval)
- Sub-agents never write directly to main memory

### Sub-Agent Output Storage

| Output type | Storage | Lifecycle |
|-------------|---------|-----------|
| Work artifacts (code, docs) | `~/zylos/sessions/<id>/workspace/` | Survives session kill; cleanup by supervisor policy |
| Conversation records | C4 DB, tagged with `session_id` | Persistent; main agent can query but doesn't auto-see |
| Structured knowledge | `context.db` via `store.write()` | Persistent; promotable to main memory |

## Session Lifecycle

### Spawn

```
spawn(purpose, { capability, projection_rules }) → session_id
```

1. Create session directory (`~/zylos/sessions/<session_id>/`)
2. Initialize context store with projected information
3. Start Claude Code process
4. Inject session-start hook:
   - Load identity + state + session's context store
   - Load conversation summary from previous session (if continuation)
   - Set purpose, capability boundaries, available skills
   - Inject dashboard hooks with `session_id` tag
5. Register with supervisor
6. Bind to channel thread (if applicable)

The session-start hook is the key to **infinite context continuity**: each session picks up where the previous one left off via memory + context store + conversation summary.

### Context Rotation

When a session approaches context limit (~90%):

1. Supervisor triggers memory sync on the session
2. Session writes key context to its context store
3. Session is killed
4. Supervisor spawns a fresh session with same purpose + capability + channel bindings
5. New session loads context store + previous session summary via session-start hook
6. User and channel binding are transparent — no visible interruption

### Other Operations

```
attach(session_id, channel, thread_id)
  - binds a channel thread to this session

detach(session_id, channel)
  - unbinds channel thread

kill(session_id)
  - graceful shutdown: memory sync, write final state
  - process terminated, resources freed

list() → [{ id, purpose, capability, status, context_usage, bindings, last_activity_at }]
```

Auto-lifecycle rules:
- Sessions warm for days by default (resource cost is acceptable)
- Sessions at >90% context → automatic rotation (see above)
- Maximum concurrent sessions: configurable, default based on available memory (~200-400MB per session)

### Cross-Session Communication

Sessions may need to hand off work:

```
Session A (thinking with Howard):
  "Let's deploy that LiveKit change we discussed"
    → supervisor spawns/finds ops session
    → sends task summary as a handoff message
    → Session B (ops) executes the deploy
    → Session B posts result to shared state
    → supervisor notifies Session A of completion
```

Handoff protocol:
- `handoff(targetSessionId | "new", { purpose, context_summary, task })` — send work to another session
- `notify(sourceSessionId, { event, result })` — session reports outcome back
- Context summaries are text-only (no raw conversation transfer) to preserve isolation

## Supervisor as Unified Activity Monitor

The supervisor replaces per-session AM instances:

- **Heartbeat**: supervisor pings each session periodically; crashed sessions are restarted from context store
- **Hook injection**: on spawn, supervisor auto-injects dashboard hooks into the session's Claude Code settings, with endpoint tagged by session_id: `POST /api/ingest?session_id=sess_xxx`
- **Dashboard integration**: hook data flows to the dashboard, partitioned by session_id

No per-session AM process needed. Supervisor is the single AM for all sessions.

## Dashboard Integration

Sub-agents are NOT shown as independent fleet tiles (which would duplicate system-level metrics like CPU/memory/disk). Instead:

```
Fleet Wall
├── zylos01 tile (main card: CPU, mem, disk, cost, context, rate limit)
│   └── Sub-agent indicators: small avatars with status dots
│       Click → detail page → sub-agent list (purpose / status / context%)
│       Click specific sub-agent → activity feed / conversation summary
├── Jinglever tile
├── zylos0t tile
```

- **Main tile** shows system-level metrics (shared across all local sessions) plus sub-agent presence indicators
- **Sub-agent detail** shows only session-specific data: purpose, status, context usage, current activity
- Sub-agents automatically register/deregister from the fleet display on spawn/kill

## User Commands

Available from any channel:

| Command | Effect |
|---------|--------|
| `/sessions` | List active sessions with purpose, status, context % |
| `/new <purpose>` | Spawn a new session and bind current thread to it |
| `/switch <session>` | Rebind current thread to a different session |
| `/kill <session>` | Terminate a session |

On platforms with native thread support, `/new` automatically creates a new thread/topic.

## Open Questions

1. **Memory contention**: Two internal sessions editing the same memory file simultaneously. Mitigation: file-level locking, or designate one session as memory-writer with others read-only?

2. **Supervisor persistence**: Supervisor state (session registry) stored in SQLite or JSON? Must survive supervisor restart.

3. **Identity**: All sessions share "zylos01". Sub-identities ("zylos01/ops") for audit trail? Or just session_id tagging?

4. **Scheduler integration**: Dedicated ops session for scheduled tasks, or supervisor routes each task to the most relevant session?

5. **Projection quality**: LLM-based context projection may extract too much or too little. How to evaluate and tune projection accuracy?

6. **Cross-session memory sync**: When one session updates memory, should other sessions be notified? Or do they re-read on next access?

## Non-Goals (Phase 1)

- Multi-machine session distribution (all sessions on one host)
- Session migration (move a session to a different machine)
- Session forking (clone a session's context)
- Cross-agent sessions (sessions spanning zylos01 + zylos0t)
