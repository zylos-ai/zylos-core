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
│  Shared State (memory/, components/, .env)  │  Filesystem-level sharing
└─────────────────────────────────────────────┘
```

### Session Supervisor

A lightweight Node.js process (not an LLM session) that manages the session pool.

Responsibilities:
- **Lifecycle**: spawn, list, attach, detach, kill sessions
- **Routing**: decide which session handles an incoming message
- **Health**: monitor session liveness, restart crashed workers
- **Resource**: enforce concurrency limits based on system resources

The supervisor does NOT hold conversation context. It is a thin control plane.

### Session Workers

Each worker is an independent Claude Code process with its own context window.

Properties:
- `id`: unique identifier (e.g., `sess_a1b2c3`)
- `purpose`: human-readable tag (e.g., "deploy-dashboard", "howard-chat", "research-livekit")
- `status`: idle / busy / waiting_for_input
- `context_usage`: percentage of context window consumed
- `created_at`: timestamp
- `last_activity_at`: timestamp
- `channel_bindings`: which channel threads are routed to this session

Workers share the filesystem (memory files, component data, .env) but have fully isolated context windows. A worker can read another worker's output via shared files but cannot access another worker's conversation history.

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

### Session Lifecycle

```
spawn(purpose) → session_id
  - starts a new Claude Code process
  - injects standard memory (identity, state, references)
  - registers with supervisor

attach(session_id, channel, thread_id)
  - binds a channel thread to this session
  - future messages from that thread route here

detach(session_id, channel)
  - unbinds channel thread
  - session continues but receives no new user messages

kill(session_id)
  - graceful shutdown: session writes final state to memory
  - process terminated, resources freed

list() → [{ id, purpose, status, context_usage, bindings, last_activity_at }]
  - task-manager view of all active sessions
```

Auto-lifecycle rules:
- Sessions idle for >30 minutes with no channel binding → eligible for auto-kill
- Sessions at >90% context → supervisor prompts: memory sync + spawn fresh continuation, or kill
- Maximum concurrent sessions: configurable, default based on available memory (~200-400MB per session)

### User Commands

Available from any channel:

| Command | Effect |
|---------|--------|
| `/sessions` | List active sessions with purpose, status, context % |
| `/new <purpose>` | Spawn a new session and bind current thread to it |
| `/switch <session>` | Rebind current thread to a different session |
| `/kill <session>` | Terminate a session |

On platforms with native thread support, `/new` automatically creates a new thread/topic.

## Open Questions

1. **Memory contention**: Two sessions editing the same memory file simultaneously. Mitigation: file-level locking, or designate one session as memory-writer with others read-only?

2. **Supervisor persistence**: Supervisor must survive session crashes. PM2 manages it. But what about supervisor state (session registry)? SQLite or JSON file?

3. **Cost model**: N sessions × API token consumption. Should idle sessions be suspended (context serialized to disk) rather than kept warm? Wake-on-message?

4. **Identity**: All sessions share the identity "zylos01". Should they? Or should sessions have sub-identities ("zylos01/ops", "zylos01/research") for audit trail purposes?

5. **Scheduler integration**: Which session handles scheduled tasks? Dedicated ops session, or supervisor routes each task to the most relevant session?

6. **Activity Monitor**: Current C2 monitors one session. With N sessions, does it monitor all? Report aggregate health?

## Non-Goals (Phase 1)

- Multi-machine session distribution (all sessions on one host)
- Session migration (move a session to a different machine)
- Session forking (clone a session's context)
- Cross-agent sessions (sessions spanning zylos01 + zylos0t)
