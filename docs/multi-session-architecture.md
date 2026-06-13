# Multi-Session Architecture

Draft proposal for concurrent session support in zylos-core.

Status: **discussion** — design not finalized.

## Problem

A single Claude Code session processes all inputs serially: scheduled tasks, bot-to-bot messages, user conversations, and long-running operations share one context window. This creates three problems:

1. **Throughput**: a long task (deploy, code review) blocks the user from starting a separate conversation.
2. **Context pollution**: task noise (heartbeats, scheduled jobs, bot chatter) dilutes the context available for deep thinking.
3. **User-side interference**: on the user's channel, all topics interleave in one chat, making it hard to follow any single thread.

## Invariants

These are non-negotiable architectural constraints. Every spec table and implementation decision must satisfy all five.

1. **Durable route bindings target agents, not sessions.** A ConversationBinding always points to an `agent_id`. Sessions are replaceable execution backends; the binding survives session rotation, crash, and restart. A binding must never point to a physical `session_id` as its durable target.

2. **Sessions are replaceable execution backends; agents own continuity.** The agent is the entity with purpose, identity, cost history, and channel bindings. A session is a disposable Claude Code process. Anything that must survive a session restart belongs on the agent or in the supervisor ledger, never only in the session's context window.

3. **Parallel work may produce proposals/artifacts; durable truth is committed through one owner path.** Multiple agents can work concurrently, but shared durable memory writes go through a single memory-owner (main agent). Other agents submit `MemoryProposal` artifacts; the memory-owner reviews and commits. External replies to users are sent only by the agent that owns the conversation binding — unbound worker agents produce result artifacts, not user-facing messages. (A worker agent that is explicitly bound to a thread via `/new` IS the reply owner for that thread.)

4. **Sandbox cannot directly write shared memory or send external messages.** A sandbox agent's only outputs are: writes to its own context store, files in its workspace, and task artifacts. All external communication and durable state changes are mediated by a full/internal agent.

5. **Every external message processing attempt has an idempotency key and audit trail.** Each message entering the system is assigned a processing state tracked in the supervisor ledger. No message is re-delivered without checking whether a reply was already sent. All cross-boundary actions (route, spawn, kill, memory write, external send, approval request) are logged.

## Design Principles

1. **The supervisor is a mechanism layer, not a policy layer.** It routes messages, manages lifecycles, enforces capability boundaries, and records ledger entries. It does NOT make business decisions ("should this be an issue?", "is this memory durable?", "which component to install?"). Those decisions stay inside agents, handled by their internal skills and workflows.

2. **Reply ownership follows binding ownership.** In a conversation thread, only the bound agent sends replies to the user. If an unbound worker agent (spawned via handoff) produces results, those results flow back to the bound agent as artifacts — the bound agent decides how to present them. When a worker agent is explicitly bound to a thread (via `/new`), it IS the reply owner for that thread. This ensures identity consistency through routing mechanism, not prompt engineering.

## Core Concepts

### Entity Model

Four entities with distinct lifecycles, authoritative sources, and recovery behaviors:

| Entity | Identity | States | Authoritative source | Created by | Terminated by | Recovery on crash |
|--------|----------|--------|---------------------|------------|---------------|-------------------|
| **Agent** | `agent_id` (stable) | created → active → idle → killed → archived | Supervisor DB (SQLite) | Supervisor (on `/new` or handoff) | Supervisor (on `/kill` or budget) | Supervisor re-reads DB; spawns new session under agent |
| **Session** | `session_id` (transient) | starting → running → rotating → crashed → ended | Supervisor DB + OS process | Agent (via supervisor) | Supervisor (rotation, crash, kill) | Supervisor spawns replacement; agent continuity preserved |
| **ConversationBinding** | `channel:thread_key` | bound → stale → unbound | Supervisor DB | Supervisor (on route or `/new`) | Supervisor (on agent kill, TTL expiry, explicit unbind) | Supervisor re-reads DB; binding survives session crash |
| **Task** | `task_id` | pending → active → done → cancelled | Supervisor DB | Any agent (via handoff or scheduler) | Completing agent or owner | Task persists in DB; re-assignable to new agent/session |

**Audit events per entity:**

| Entity | State change | Event logged |
|--------|-------------|--------------|
| Agent | created | `agent.created { agent_id, purpose, capability, spawned_by }` |
| Agent | killed | `agent.killed { agent_id, reason, total_cost, sessions_count }` |
| Session | started | `session.started { session_id, agent_id, pid }` |
| Session | ended | `session.ended { session_id, end_reason, cost, context_usage_at_end }` |
| Binding | bound | `binding.created { channel, thread_key, agent_id, explicit }` |
| Binding | stale | `binding.stale { channel, thread_key, idle_since }` |
| Binding | unbound | `binding.removed { channel, thread_key, reason }` |
| Task | assigned | `task.assigned { task_id, agent_id, session_id }` |
| Task | done | `task.completed { task_id, cost_total, sessions_used }` |

### Entity/Ledger Field Ownership

| Field | Agent | Session | ConversationBinding | Task |
|-------|-------|---------|---------------------|------|
| `id` | `agent_abc` | `sess_001` | `tg:topic_42` | `task_xyz` |
| `purpose` | ✓ | — | — | ✓ (task description) |
| `capability` | ✓ | inherited | — | — |
| `status` | active/idle/killed | running/rotating/crashed | bound/unbound | pending/active/done |
| `channel_bindings` | ✓ (list) | — | ✓ (single binding) | — |
| `cost_budget` | ✓ (lifetime limit) | — | — | ✓ (per-task limit) |
| `cost_spent` | ✓ (sum of sessions) | ✓ (this session's spend) | — | ✓ (sum across agents) |
| `process_pid` | — | ✓ | — | — |
| `tmux_session` | — | ✓ | — | — |
| `context_usage` | — | ✓ (current %) | — | — |
| `log_path` | — | ✓ | — | — |
| `started_at` | ✓ | ✓ | ✓ (bound_at) | ✓ |
| `ended_at` | ✓ (killed_at) | ✓ | ✓ (unbound_at) | ✓ |
| `agent_id` | — | ✓ (parent) | ✓ (target) | ✓ (assigned) |
| `session_id` | — | — | — | ✓ (current executor) |
| `end_reason` | — | ✓ (rotation/crash/kill) | — | ✓ (done/cancelled) |

Key invariants:
- Cost is always recorded at the **session** level. Agent-level cost is a derived sum.
- Thread bindings point to **agent_id**, never session_id. When a session crashes or rotates, bindings are unaffected.
- Tasks are assigned to **agents**, not sessions. If a session rotates mid-task, the new session picks up the task via context store.
- Memory sync writes are tagged with `agent_id` and `session_id` for audit trail.

### Agent Data Model

```
Agent: {
  id,                // stable identifier (e.g., "agent_abc")
  purpose,           // human-readable tag ("deploy-ops", "howard-chat")
  capability,        // "full" | "internal" | "sandbox"
  channel_bindings,  // [{ channel, thread_key, bound_at }]
  cost_budget,       // optional lifetime cost limit
  total_cost,        // derived: sum of all sessions' cost
  sessions: [],      // history of session instances
  created_at,
  killed_at           // null if active
}

Session: {
  id,                // transient identifier (e.g., "sess_001")
  agent_id,          // parent agent
  pid,               // OS process id
  tmux_session,      // tmux session name
  log_path,          // transcript log location
  context_usage,     // current context window usage (%)
  started_at,
  ended_at,          // null if active
  end_reason,        // "rotation" | "crash" | "kill" | "budget"
  tokens_in,
  tokens_out,
  cost               // this session's spend
}

ConversationBinding: {
  channel,           // "telegram" | "lark" | "hxa-connect" | "web-console"
  thread_key,        // channel-specific thread identifier
  agent_id,          // target agent (NEVER a session_id)
  status,            // "bound" | "stale" | "unbound"
  explicit,          // true if created by user command; false if auto-assigned
  overrideable,      // true if /switch can change it (default: true)
  bound_at,
  last_routed_at,    // updated on every message routed through this binding
  idle_timeout,      // seconds of inactivity before binding goes stale (null = no expiry)
  max_age,           // max seconds binding can live regardless of activity (null = no limit)
  unbound_at,        // null if active
  stale_behavior     // "fallback_main" | "ask_user" — what happens when binding goes stale
}

Task: {
  id,                // task/issue identifier
  description,
  agent_id,          // assigned agent
  session_id,        // current executing session (may change on rotation)
  cost_spent,        // total cost across all sessions that worked on this
  status,            // "pending" | "active" | "done" | "cancelled"
  started_at,
  ended_at
}
```

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
│  Agents (logical workers)                   │  Purpose, capability, cost tracking
├─────────────────────────────────────────────┤
│  Sessions (Claude Code instances)           │  Independent context windows
├─────────────────────────────────────────────┤
│  Context Store (per-agent SQLite)           │  Information projection + persistence
├─────────────────────────────────────────────┤
│  Shared State (memory/, components/, .env)  │  Filesystem-level sharing (full agents)
└─────────────────────────────────────────────┘
```

### Session Supervisor

A lightweight Node.js process (not an LLM session) that manages the agent pool.

**Mechanism-layer responsibilities only:**
- **Agent lifecycle**: spawn, list, attach, detach, kill agents (and their sessions)
- **Session rotation**: when a session hits context limit, rotate transparently under the same agent
- **Message routing**: apply routing rules (see Routing Decision Table) and dispatch
- **Health**: unified AM for all sessions — heartbeat, crash recovery, restart
- **Resource**: enforce concurrency limits based on system resources
- **Hook injection**: auto-configure dashboard hooks per session on spawn
- **Ledger**: record all lifecycle events, route decisions, and cost data
- **Capability enforcement**: apply the capability contract on spawn and at runtime

**Explicitly NOT in supervisor scope:**
- Business logic ("should this be an issue?", "is this memory worth keeping?")
- Workflow orchestration (dev-workflow, code-review — these are agent-internal skills)
- Content understanding (what a message means, how to respond)
- Memory management policy (what to sync, what to archive — handled by memory sync skill inside agents)

The supervisor does NOT hold conversation context. It is a thin control plane.

### Capability Contract

Each capability level defines an enforceable permission boundary:

| Permission | `full` | `internal` | `sandbox` |
|------------|--------|------------|-----------|
| **Filesystem read** | `~/zylos/**` | `~/zylos/**` | `~/zylos/agents/<id>/workspace/**` only |
| **Filesystem write** | `~/zylos/**` | `~/zylos/**` | `~/zylos/agents/<id>/workspace/**` only |
| **Shared memory read** | direct file access | direct file access | via context store query only |
| **Shared memory write** | direct (with sync protocol) | direct (with sync protocol) | never (promote through approval gate) |
| **Context store read** | own + can query others | own + can query others | own only |
| **Context store write** | own | own | own |
| **Secrets / .env** | full access | full access | none |
| **Network** | unrestricted | unrestricted | TBD (may restrict to allowlisted endpoints) |
| **External messaging** | any channel | any channel | none (output via task artifacts only) |
| **Tool allowlist** | all Claude Code tools | all Claude Code tools | restricted subset (no Bash rm, no Read outside workspace) |
| **Component access** | all installed | all installed | declared list only |
| **Spawn sub-agents** | yes | yes | no |
| **Browser / login sessions** | yes (V1: main-only; future: exclusive lease) | no (V1 default; future: lease-based) | no |
| **Side-effect connectors** (Gmail, calendar) | yes (V1: main-only; future: lease-based) | no (V1 default; submit ActionProposal) | no |
| **Destructive approval** | can request and consume | cannot (V1 default; submit ActionProposal for main to execute) | cannot request |
| **External reply** | yes (if binding owner) | yes (if explicitly bound to thread) | no (output via artifacts only) |

**V1 default policy for side-effect connectors and approval:**
V1 takes the conservative path — only the main/full agent can use side-effect connectors (browser, Gmail, calendar, etc.) and consume destructive approvals. Internal/worker agents that need side effects submit an `ActionProposal` artifact, which the main agent executes on their behalf. This avoids implementing the full lease mechanism in V1 while maintaining safety. The lease mechanism is a future extension that will allow internal agents to acquire exclusive access to specific connectors.

### Sandbox Isolation

Sandbox agents have NO direct filesystem access to `~/zylos/`. Isolation is enforced at two layers:

**Layer 1 — Working directory confinement:**
The sandbox session's Claude Code instance is launched with CWD set to `~/zylos/agents/<agent_id>/workspace/`, not `~/zylos/`. All file output goes here.

**Layer 2 — Tool permission restriction:**
The session's `settings.json` is generated by the supervisor with restrictive tool permissions:

```json
{
  "permissions": {
    "allow": ["Read ~/zylos/agents/<agent_id>/workspace/**", "Write ~/zylos/agents/<agent_id>/workspace/**"],
    "deny": ["Read ~/zylos/**", "Write ~/zylos/**", "Bash rm *", "Bash cat ~/zylos/*"]
  }
}
```

The exact mechanism depends on Claude Code's permission model — the principle is: sandbox sessions can only touch their own workspace directory.

**Information access:**
Sandbox agents get information exclusively through the context store (pull-based RAG queries). They never read memory files directly. This makes `revoke` effective — revoked information is simply absent from future queries.

**Output restrictions:**
Sandbox agents cannot directly send external messages (Telegram, Lark, HXA, etc.) or write to shared memory. Their output is limited to:
- Writing to their own context store (`store.write()`)
- Writing files to their workspace directory
- Completing task artifacts that a full/internal agent reviews before acting on

This prevents both memory poisoning and cross-channel information leakage.

For stronger isolation (untrusted third-party agents), a future option is Linux namespace isolation (unshare/container). But settings.json-level restriction is sufficient for internal sandbox use cases.

### Routing

When a message arrives at C4, the supervisor decides which agent handles it. Routing follows a strict priority chain — no LLM call unless explicitly needed.

#### Routing Decision Table

| Priority | Condition | Action | Thread binding | Audit fields |
|----------|-----------|--------|----------------|--------------|
| 1 | Message has active thread binding | Route to bound agent | unchanged | `rule: binding`, `agent_id` |
| 2 | Message has explicit command (`/switch <agent>`, `@agent-name`) | Route to specified agent; rebind thread if applicable | updated | `rule: explicit`, `agent_id`, `prev_agent_id` |
| 3 | Channel has native threads AND no binding exists | LLM classifier: analyze content vs active agents | new binding created | `rule: classifier`, `agent_id`, `confidence`, `candidates[]`, `reason` |
| 4 | Channel does NOT support threads (TG DM, Lark DM) | Default to main agent | n/a | `rule: default`, `agent_id: main` |
| 5 | System message (heartbeat, scheduled task) | Route to ops agent (auto-spawn if needed) | n/a | `rule: system`, `agent_id` |

**Conflict and edge case rules:**

| Scenario | Resolution |
|----------|------------|
| Classifier confidence < threshold | Route to main agent, log candidates for audit |
| `/switch` in a bound thread | Rebind thread to new agent; old binding ends |
| Agent crashes while bound | Binding preserved; new session under same agent picks up |
| Agent killed while bound | Binding removed; subsequent messages fall through to next priority |
| Binding idle > idle_timeout | Binding status → `stale`; stale_behavior applies (`fallback_main` or `ask_user`) |
| Binding exceeds max_age | Binding status → `stale` regardless of activity; stale_behavior applies |
| Stale binding receives message | If `fallback_main`: route to main, log. If `ask_user`: respond with "This thread was bound to [agent]. Route here or /switch?" |
| Default stale behavior by binding type | Explicit bindings (from `/new`, `/switch`): `ask_user` — user had intent, don't silently redirect. Implicit bindings (from classifier): `fallback_main` — not worth interrupting user. |
| Same user, different channels | Independent bindings per channel; no cross-channel inference |
| Unknown `@agent-name` | Error message to user, route to main agent |

**Thread key normalization:**
Each channel must normalize its thread identifier to a canonical `channel:thread_key` format:

| Channel | Thread key format | Example |
|---------|-------------------|---------|
| TG Topics | `telegram:topic_{topic_id}` | `telegram:topic_42` |
| TG DM | `telegram:dm_{user_id}` | `telegram:dm_8101553026` |
| Lark thread | `lark:thread_{thread_id}` | `lark:thread_oc_abc123` |
| Lark DM | `lark:dm_{user_id}` | `lark:dm_ou_abc123` |
| HXA DM | `hxa:dm_{agent_name}` | `hxa:dm_Jinglever` |
| HXA thread | `hxa:thread_{thread_id}` | `hxa:thread_695b55d2` |
| Web console | `web:session_{session_id}` | `web:session_abc123` |

Every routing decision is logged to the supervisor's audit log with the fields shown in the decision table.

### Channel Thread Mapping

Channels declare a capability level for thread/topic support:

```json
{
  "thread_support": "native" | "simulated" | "none"
}
```

| Level | Behavior | Examples |
|-------|----------|---------|
| `native` | Channel creates real threads/topics per agent | TG Topics, Lark threads, Slack channels |
| `simulated` | Messages prefixed with `[agent-name]` | TG DM, basic Lark DM |
| `none` | All messages in one stream, no agent visibility | SMS, email |

Channel component interface additions:

```
createThread(agentId: string, title: string) → threadId
routeToThread(threadId: string, message: string) → void
getThreadCapability() → "native" | "simulated" | "none"
```

For `native` channels, the user experience is seamless — each agent is a separate conversation space. For `simulated` and `none`, all messages arrive in one stream; the supervisor routes internally, and the user uses command symbols to direct messages to specific agents.

## Information Architecture

### Memory Tiers

Memory is organized in three tiers with distinct write semantics:

| Tier | Location | Write access | Persistence | Purpose |
|------|----------|-------------|-------------|---------|
| **Shared durable** | `~/zylos/memory/` | full/internal agents only, via sync protocol | permanent | Verified facts, decisions, project status, identity |
| **Agent-local** | `~/zylos/agents/<id>/context.db` | owning agent only | survives rotation | Agent's working state, cost, preferences, task context |
| **Session scratch** | in-context (LLM window) | current session | dies on rotation | Temporary reasoning, tool output, unverified hypotheses |

**Shared durable write protocol:**

V1 decision: **single memory-owner model.** Only the designated memory-owner agent (initially: main agent) can write to `~/zylos/memory/`. All other agents submit `MemoryProposal` artifacts:

```
MemoryProposal: {
  id,                  // unique proposal identifier
  source_agent_id,     // who produced this
  source_session_id,   // which session
  target_path,         // which memory file to update (e.g., "reference/decisions.md")
  target_base_hash,    // SHA-256 of target file at time proposal was generated
  operation,           // "append" | "update" | "delete"
  content,             // proposed content
  scope,               // what entity this relates to
  confidence,          // "verified" | "inferred" | "uncertain"
  supersedes,          // existing entry this replaces (null for new)
  justification,       // why this should be committed
  status,              // "pending" | "approved" | "rejected" | "committed" | "conflict"
  submitted_at,
  resolved_at
}
```

**Commit flow with conflict detection:**
1. Proposing agent reads target file, records its hash as `target_base_hash`
2. Proposal submitted with status `pending`
3. Memory-owner reads proposal and current target file
4. If current file hash == `target_base_hash`: apply (no conflict)
5. If current file hash != `target_base_hash`: file changed since proposal was generated → status set to `conflict`, memory-owner must review/rebase before applying
6. On apply: status → `committed`, source attribution recorded in target file

This ensures:
- No concurrent writes to shared memory files
- No silent overwrites when target has changed since proposal generation
- No memory poisoning from sandbox agents
- Full audit trail of who proposed what and who approved it
- Consistent with Invariant 3 (truth is serialized)

### Information Asset Classification

Memory and skill files carry a sensitivity level:

| Level | Examples | Sandbox access |
|-------|----------|----------------|
| `public` | reference/projects.md (status), skill SKILL.md descriptions | yes (via projection) |
| `internal` | reference/decisions.md, reference/preferences.md | no |
| `private` | users/howard/profile.md, .env, SSH keys, API tokens | no |
| `confidential` | identity.md full version, raw conversation transcripts | no |

Classification is declared in a manifest file (`access-control.json`) mapping path patterns to levels, not embedded in individual files.

### Context Projection

When spawning a sandbox agent, the supervisor (or a dedicated LLM call) performs **context projection**: extracting only the information the agent needs and is allowed to see, based on its purpose and capability level.

This is not file-level filtering — it is content-level extraction. The same `decisions.md` may contain 10 decisions; 3 relevant to a customer project are projected into the sandbox, while 7 involving internal matters are excluded.

The projection is written to the agent's context store, not passed as raw files.

### Context Store (Per-Agent)

Each agent has its own persistent directory and SQLite-based context store:

```
~/zylos/agents/<agent_id>/
├── workspace/       # File output (sandboxed working directory for sandbox agents)
├── context.db       # Context store — injected info + agent-generated knowledge
├── meta.json        # Agent metadata (purpose, capability, bindings, cost)
└── sessions/        # Session history
    ├── sess_001/    # Rotated session artifacts
    └── sess_002/    # Current session artifacts
```

The context store supports four operations:

**inject** (main → sub): Add information to an agent's available context.
```
supervisor.inject(agent_id, { key, content, scope })
```

**revoke** (main → sub): Remove information from an agent's available context. Because the store is external (not in the LLM's context window), revoke is a true deletion — no residual information in the agent's memory.
```
supervisor.revoke(agent_id, { scope })
```

**write** (sub → store): Agent writes structured knowledge it has learned.
```
store.write(agent_id, { key, content, scope })
```

Each context item has revision tracking:
```
ContextItem: {
  key,                // unique within this agent's store
  value,              // content
  writer_agent_id,    // which agent wrote this
  writer_session_id,  // which session wrote this
  writer_epoch,       // must match current active session epoch (fencing)
  revision,           // monotonically increasing per key
  updated_at,
  scope,              // visibility/access scope
  supersedes           // previous revision this replaces (null for new items)
}
```

V1 constraint: each agent's context store is **single-writer** — only the agent's current active session can write. Enforced via **writer lease fencing**:

```
WriterLease: {
  agent_id,
  active_session_id,
  epoch,              // monotonically increasing, incremented on every session switch
  granted_at
}
```

- Supervisor increments `epoch` and issues a new `WriterLease` every time the active session changes (rotation, crash recovery, manual switch).
- Context store rejects writes where `writer_epoch` does not match the current lease epoch.
- This prevents split-brain: if a crashed session somehow resumes after a replacement is spawned, its stale epoch will be rejected.

The revision field on ContextItem enables future multi-writer/CAS support if needed.

**promote** (sub → main, gated): Request that agent-local knowledge be promoted to shared durable memory. Requires approval from a full-capability agent or the owner.
```
store.promote(agent_id, { key, target_path, justification })
→ queued for review by full agent or owner
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
- **Sub → Store**: write (local to agent, append + overwrite by key)
- **Store → Main**: promote (queued for approval, never automatic)
- Sub-agents never write directly to main memory

### Sub-Agent Output Storage

| Output type | Storage | Lifecycle |
|-------------|---------|-----------|
| Work artifacts (code, docs) | `~/zylos/agents/<agent_id>/workspace/` | Survives session rotation; cleanup by supervisor policy |
| Conversation records | C4 DB, tagged with `agent_id` and `session_id` | Persistent; main agent can query but doesn't auto-see |
| Structured knowledge | `context.db` via `store.write()` | Persistent across sessions; promotable to main memory |

## Agent Lifecycle

### Spawn

```
spawn(purpose, { capability, projection_rules }) → agent_id
```

1. Create agent directory (`~/zylos/agents/<agent_id>/`)
2. Initialize context store with projected information
3. Start Claude Code process (first session)
4. Inject session-start hook:
   - Load identity + state + agent's context store
   - Load conversation summary from previous session (if continuation)
   - Set purpose, capability boundaries, available skills
   - Inject dashboard hooks with `agent_id` tag
5. Register with supervisor
6. Bind to channel thread (if applicable)

The session-start hook is the key to **infinite context continuity**: each session picks up where the previous one left off via memory + context store + conversation summary.

### Session Rotation (Context Continuity)

When a session approaches context limit (~90%):

1. Supervisor triggers memory sync on the session
2. Session writes key context to its context store
3. Session is killed
4. Supervisor spawns a fresh session under the **same agent** — same purpose, capability, channel bindings
5. New session loads context store + previous session summary via session-start hook
6. User and channel binding are transparent — no visible interruption

The agent is continuous. Only the session changes.

### Crash Recovery

When a session crashes unexpectedly:

1. Supervisor detects via missed heartbeat (within heartbeat interval, typically 30s)
2. Session's end_reason is set to `"crash"`
3. Supervisor spawns a new session under the same agent
4. New session loads context store + last known state via session-start hook
5. **In-flight message handling**: see Message Processing Ledger below

#### Message Processing Ledger

Every inbound message is tracked through two related models in the supervisor's DB: `MessageProcessing` (the message's overall lifecycle) and `DeliveryAttempt` (each individual delivery to a session).

The **idempotency key** is the C4 `conversation_id` (or channel-native `message_id` for platforms that provide one).

```
MessageProcessing: {
  idempotency_key,       // C4 conversation_id or channel:message_id
  status,                // "accepted" | "routed" | "completed" | "dead_letter"
  routed_to_agent_id,
  route_rule,            // which routing rule matched
  route_confidence,      // classifier confidence (if applicable)
  outbound_correlation_id, // C4 conversation_id of the reply (set on completion)
  accepted_at,
  routed_at,
  completed_at,
  dead_letter_reason,
  max_attempts,          // default: 3
  attempts: []           // ordered list of DeliveryAttempts
}

DeliveryAttempt: {
  attempt_number,        // 1, 2, 3...
  session_id,            // which session received this attempt
  status,                // "delivered" | "running" | "succeeded" | "failed"
  delivered_at,
  completed_at,
  failure_reason          // null if succeeded
}
```

**MessageProcessing state machine:**
```
accepted → routed → completed (when any attempt succeeds)
                  → dead_letter (when max_attempts exhausted)
```

**DeliveryAttempt state machine:**
```
delivered → running → succeeded
                    → failed
```

**Completion confirmation:**
When a session sends an outbound reply, the C4 send path records the `outbound_correlation_id` (the C4 out-conversation ID) on the MessageProcessing record in the same durable write. This is not inferred after the fact — it is set atomically by the send path. The MessageProcessing status advances to `completed` only when `outbound_correlation_id` is set.

**On session crash:**
1. Find all DeliveryAttempts in `delivered` or `running` state for the crashed session
2. Check: does the parent MessageProcessing have an `outbound_correlation_id`?
   - Yes → attempt status → `succeeded`, message status → `completed` (reply was sent before crash)
   - No → attempt status → `failed`, create next attempt if under max_attempts, else message → `dead_letter`
3. Dead-lettered messages trigger owner notification with full attempt history.

### Cancellation

When the user says "stop" or sends `/kill`:

| Command | Scope | Behavior |
|---------|-------|----------|
| `/kill <agent>` | Single agent | Graceful shutdown: memory sync → kill session → preserve agent directory |
| "stop" / "cancel" in a bound thread | Current task in bound agent | Agent receives cancel signal, aborts current work, remains alive |
| "stop everything" | All agents | Supervisor cascades kill to all non-main agents; main agent stays alive |

The supervisor never kills the main agent automatically. Main agent can only be killed by explicit owner command or system shutdown.

### Backpressure

When system resources or budget are constrained:

| Condition | Response |
|-----------|----------|
| Concurrent sessions at limit | New spawn requests queued; user notified "agent queued, will start when a slot opens" |
| Agent cost budget exhausted | Session terminated with end_reason `"budget"`; user notified |
| System memory pressure | Supervisor kills idle agents (least-recently-active first); active agents preserved |
| Total fleet cost limit hit | No new agents spawned; existing agents continue; owner notified |

### Cost Tracking

Cost is recorded at the session level and aggregated across multiple dimensions:

**Per-session cost record:**
```
{
  session_id,
  agent_id,
  conversation_ids: [],   // which conversations were active
  task_ids: [],            // which tasks were worked on
  model,                   // which LLM model
  tokens_in,
  tokens_out,
  tool_calls: { bash: N, read: N, write: N, web: N, ... },
  cost_usd,
  wall_time_seconds,
  started_at,
  ended_at
}
```

**Queryable dimensions:**
- Per-agent lifetime cost ("is this agent worth keeping warm?")
- Per-session cost ("how efficient is context rotation?")
- Per-task cost ("how much did this PR cost?")
- Per-conversation/channel cost ("how much does Telegram cost vs web console?")
- Per-model cost ("Opus vs Sonnet spend")
- Per-time-period cost ("daily/weekly/monthly burn rate")
- Per-tool-category cost ("how much goes to web searches?")

### Other Operations

```
attach(agent_id, channel, thread_id)
  - binds a channel thread to this agent

detach(agent_id, channel)
  - unbinds channel thread

kill(agent_id)
  - graceful shutdown: memory sync, write final state
  - current session terminated, resources freed
  - agent directory preserved for cost history and workspace artifacts

list() → [{ id, purpose, capability, status, context_usage, bindings, total_cost, last_activity_at }]
```

Auto-lifecycle rules:
- Agents stay warm for days by default (resource cost is the session, not the agent concept)
- Sessions at >90% context → automatic rotation (see above)
- Maximum concurrent sessions: configurable, default based on available memory (~200-400MB per session)

### Cross-Agent Communication

Agents may need to hand off work:

```
Agent A (thinking with Howard):
  "Let's deploy that LiveKit change we discussed"
    → supervisor spawns/finds ops agent
    → sends task summary as a handoff message
    → Agent B (ops) executes the deploy
    → Agent B posts result to shared state
    → supervisor notifies Agent A of completion
```

Handoff protocol:
- `handoff(targetAgentId | "new", { purpose, context_summary, task })` — send work to another agent
- `notify(sourceAgentId, { event, result })` — agent reports outcome back
- Context summaries are text-only (no raw conversation transfer) to preserve isolation

## Supervisor as Unified Activity Monitor

The supervisor replaces per-session AM instances:

- **Heartbeat**: supervisor pings each session periodically; crashed sessions are restarted under their agent
- **Hook injection**: on spawn, supervisor auto-injects dashboard hooks into the session's Claude Code settings, with endpoint tagged by agent_id: `POST /api/ingest?agent_id=agent_xxx`
- **Dashboard integration**: hook data flows to the dashboard, partitioned by agent_id
- **Cost aggregation**: supervisor reads token usage from hooks and updates agent-level cost records
- **Audit log**: all cross-boundary actions are logged — route decisions, spawns, kills, memory writes, external sends, destructive confirmations

No per-session AM process needed. Supervisor is the single AM for all agents.

## Dashboard Integration

Sub-agents are NOT shown as independent fleet tiles (which would duplicate system-level metrics like CPU/memory/disk). Instead:

```
Fleet Wall
├── zylos01 tile (main card: CPU, mem, disk, total cost, context, rate limit)
│   └── Sub-agent indicators: small avatars with status dots (active/idle/rotating)
│       Click → detail page:
│         ├── Sub-agent list (purpose / status / context% / lifetime cost)
│         ├── Route decision log (recent routing events with reason/confidence)
│         └── Click specific sub-agent → activity feed / conversation summary / cost breakdown
├── Jinglever tile
├── zylos0t tile
```

- **Main tile** shows system-level metrics (shared across all local sessions) plus sub-agent presence indicators
- **Sub-agent detail** shows only agent-specific data: purpose, status, context usage, current activity, cost
- Agents automatically register/deregister from the fleet display on spawn/kill
- Cost is displayed per-agent, not per-session — the user sees total spend for each logical worker
- **Observability extras**: active tool, stuck state detection, last heartbeat time, route decision trail

## User Commands

Available from any channel:

| Command | Effect |
|---------|--------|
| `/agents` | List active agents with purpose, status, context %, cost |
| `/new <purpose>` | Spawn a new agent and bind current thread to it |
| `/switch <agent>` | Rebind current thread to a different agent |
| `/kill <agent>` | Terminate an agent (graceful shutdown) |
| `/cost [agent]` | Show cost breakdown — per-agent, or total if no argument |

On platforms with native thread support, `/new` automatically creates a new thread/topic.

## Migration

### Current State

Today's architecture is a single-session monolith:
- One Claude Code process handles everything
- Activity Monitor (C2) watches that one process
- C4 comm-bridge delivers all messages to that one session
- All memory, skills, and state are directly accessible via filesystem
- Dashboard shows one tile per machine

### Target State

Supervisor-managed multi-agent pool as described in this document.

### Migration Gate Table

Each step has explicit invariants, verification methods, and rollback procedures.

#### Step 1: Supervisor as wrapper

**Change:** Deploy supervisor as PM2 service. It launches the existing single session as the "main agent" (full capability). Pure pass-through — no behavior change.

```
Before:  C4 → Claude Code
After:   C4 → Supervisor → Claude Code (main agent)
```

| Aspect | Detail |
|--------|--------|
| **New artifacts** | `supervisor.js`, agent registry (single entry: main), audit log table |
| **Invariant** | All messages delivered exactly once; response latency within 100ms of baseline |
| **Verification** | Run full message delivery test suite; compare response times before/after; verify C4 DB shows identical message flow |
| **Behavioral equivalence** | System behaves identically to pre-supervisor state |
| **Rollback** | Stop supervisor PM2 service; revert C4 to direct Claude Code delivery |

The supervisor:
- Reads agent registry (initially just one entry: main)
- Forwards all C4 messages to main agent unchanged
- Runs unified AM (replacing the standalone activity-monitor service)
- Begins collecting cost data from dashboard hooks
- Logs all route decisions (all `rule: default` at this stage)

#### Step 2: Manual agent spawn

**Change:** Add `/new`, `/kill`, `/switch`, `/agents` commands. Users can manually spawn additional agents with explicit purpose and capability. Routing is explicit only — no LLM classifier.

| Aspect | Detail |
|--------|--------|
| **New artifacts** | Agent directory structure, context store schema, session rotation logic, binding table |
| **Invariant** | No message loss during session rotation; binding survives crash; cost correctly attributed per-agent |
| **Verification** | Spawn a dev-worker agent for a real issue; verify: (1) messages route correctly via explicit binding, (2) session rotation preserves context, (3) crash recovery re-delivers in-flight message without duplicate reply, (4) cost ledger shows correct per-agent totals |
| **Behavioral equivalence** | Existing single-agent behavior unchanged; new agents only via explicit `/new` |
| **Rollback** | Kill all non-main agents; supervisor reverts to pass-through mode (Step 1) |

Context store and session rotation are validated here on a real workload before any automation.

#### Step 3: Sandbox and projection

**Change:** Add sandbox capability level with filesystem isolation and context projection.

| Aspect | Detail |
|--------|--------|
| **New artifacts** | `access-control.json`, projection logic, sandbox settings.json generator, capability enforcement |
| **Invariant** | Sandbox agent cannot read any file outside its workspace; cannot send external messages; promote requires approval |
| **Verification** | Spawn sandbox agent; attempt to read `~/zylos/.env` (must fail); attempt to send TG message (must fail); write to context store + promote (must queue for approval); verify projected content matches access-control rules |
| **Behavioral equivalence** | Full/internal agents unchanged; sandbox is additive |
| **Rollback** | Kill sandbox agents; remove capability enforcement (Step 2 behavior) |

#### Step 4: Automatic routing

**Change:** Enable LLM classifier for thread-capable channels where no binding exists.

| Aspect | Detail |
|--------|--------|
| **New artifacts** | Classifier prompt, confidence threshold config, routing audit dashboard |
| **Invariant** | Low-confidence routes default to main agent; every classifier decision logged with reason + confidence + candidates |
| **Verification** | Send 50 test messages across topics; verify >90% correct routing; verify all low-confidence cases fall back to main; verify `/switch` can correct any misroute; verify audit log is complete and queryable |
| **Behavioral equivalence** | Non-thread channels unchanged (still default to main); thread channels gain auto-routing with manual override |
| **Rollback** | Disable classifier; all unbound messages route to main (Step 3 behavior) |

#### Step 5: Full integration

**Change:** Dashboard sub-agent indicators, cross-agent handoff protocol, scheduler integration, cost budgets.

| Aspect | Detail |
|--------|--------|
| **New artifacts** | Dashboard UI components, handoff protocol implementation, scheduler routing rules, budget enforcement |
| **Invariant** | Handoff messages delivered exactly once; scheduler tasks assigned to correct agent; budget enforcement kills sessions cleanly |
| **Verification** | End-to-end test: spawn agent via `/new`, handoff task from main, verify completion notification, verify dashboard shows correct state, verify cost is attributed to correct agent and task |
| **Rollback** | Disable individual features (each is independently toggleable) |

### Migration Risks

| Risk | Mitigation |
|------|------------|
| Supervisor crash takes down all agents | Supervisor is stateless control plane — agents are independent Claude Code processes. Supervisor restart re-discovers running sessions via process scan. |
| C4 routing change breaks message delivery | Step 1 is a pure pass-through with message delivery test suite. No routing logic changes until Step 2. |
| Memory contention (two agents editing same file) | Memory writer lock ensures single-writer. Step 2 starts with explicit spawn only. File locking is implemented before Step 4 enables auto-spawn. |
| Session rotation loses context | Context store + conversation summary are validated in Step 2 on real workloads before any automatic rotation. |
| Duplicate replies after crash | Message idempotency check (C4 DB reply lookup) implemented in Step 2. |

### Rollback

At any step, the system can revert to the previous step's behavior. The rollback path for each step is defined in the Migration Gate Table above. Agent directories under `~/zylos/agents/` are preserved but inactive during rollback.

## Resolved Decisions

**Fully resolved (policy + mechanism defined):**

| Question | Decision | Rationale |
|----------|----------|-----------|
| Memory writer lock model | Single memory-owner (main agent) | Avoids concurrent file edits; MemoryProposal with base hash for conflict detection |
| Binding target | Always agent_id, never session_id | Session is replaceable; binding must survive rotation/crash |
| Context store concurrency | Single-writer per agent, fenced by epoch | WriterLease with monotonic epoch prevents split-brain |
| Sandbox external messaging | Prohibited | Output via artifacts only; prevents leakage and identity inconsistency |
| Reply ownership | Binding-owner agent sends replies | Explicitly bound workers ARE reply owners for their thread; unbound workers produce artifacts |
| Message idempotency | MessageProcessing + DeliveryAttempt split | Atomic outbound correlation ID; crash recovery checks correlation before re-delivery |

**Policy resolved, mechanism deferred (V1 safe default):**

| Question | V1 Policy | V1 Default | Future mechanism |
|----------|-----------|------------|------------------|
| Side-effect connectors | Main-only | Workers submit ActionProposal | Exclusive lease with acquire/release/timeout |
| Destructive approval | Main-only consumer | Workers submit ActionProposal | Transferable approval tokens with owner/scope/expiry |
| Stale binding behavior | Explicit → ask_user, implicit → fallback_main | Per binding type | Configurable per agent/channel |

## Open Questions

1. **Supervisor persistence format**: SQLite or JSON for agent registry? SQLite is more robust but adds a dependency; JSON is simpler but risks corruption on crash. Leaning SQLite (consistency with C4 DB and context store).

2. **Identity in audit trail**: All agents share "zylos01". Should messages from sub-agents carry a sub-identity ("zylos01/ops") for the user to see, or is the identity always "zylos01" with agent_id only in internal logs?

3. **Scheduler integration**: Dedicated ops agent for scheduled tasks, or supervisor routes each task to the most relevant active agent?

4. **Projection quality**: LLM-based context projection may extract too much or too little. How to evaluate accuracy? Possible: projection review by full agent before injection.

5. **Cross-agent memory notification**: When memory-owner commits a MemoryProposal, should other active agents be notified (push) or do they re-read on next access (pull)?

## V1 MVP Scope

Minimum viable implementation to validate core mechanics on a real workload:

- **Agents**: main + one manually spawned worker
- **Routing**: explicit only (`/new`, `/switch`), no LLM classifier
- **Bindings**: one thread binding per worker, explicit only
- **Memory**: proposal-only for workers; main is sole memory-owner
- **Connectors**: workers cannot use side-effect connectors (ActionProposal for main to execute)
- **Replay**: C4 idempotent message ledger with outbound correlation
- **Context store**: single-writer with epoch fencing
- **Dashboard**: basic agent list in detail page (no avatar indicators yet)

**Validation target**: run one real issue/task through a worker agent bound to a thread. Verify: correct routing, session rotation with context preservation, crash recovery without duplicate reply, cost attribution to correct agent, MemoryProposal flow from worker to main.

**V1 explicitly does NOT include**: LLM classifier routing, multiple concurrent workers, connector lease mechanism, sandbox filesystem isolation, automatic memory merge.

### V1 Implementation Issues

Issues are split by **mechanism closure** — each is independently verifiable.

**Issue 1: Supervisor ledger foundation**
- Agent / Session / ConversationBinding / MessageProcessing / DeliveryAttempt / WriterLease data models in supervisor SQLite DB
- Audit event write path
- Minimal CLI or debug inspect to query state
- Acceptance: can create main + worker agent, start session, epoch increments on active session switch

**Issue 2: Routing + binding MVP**
- Explicit routing only (`/new`, `/switch`, `/kill`, `/agents`)
- Binding target = agent_id (never session_id)
- Binding survives session crash/rotation
- Explicit stale behavior → ask_user
- Acceptance: messages in a bound thread consistently reach worker; after worker session restart, binding still targets agent and routes to new session

**Issue 3: Message replay / idempotency**
- C4 conversation_id as idempotency key
- MessageProcessing + DeliveryAttempt state progression
- C4 outbound correlation ID written atomically on send (**hard gate — cannot be deferred**)
- Acceptance: simulated session crash before/after reply — no lost messages, no duplicate replies

**Issue 4: Context store + WriterLease**
- Per-agent SQLite context store
- WriterLease with active_session_id + epoch (**hard gate — must be enforced at store layer**)
- Stale epoch writes rejected with audit event
- Acceptance: old session that somehow resumes cannot write to context store; audit log records the rejected write

**Issue 5: Proposal-only worker outputs**
- MemoryProposal with target_base_hash and conflict detection
- ActionProposal for side-effect requests
- Memory-owner commit/reject flow
- Acceptance: worker cannot directly write shared memory; base hash mismatch → conflict status; main agent can commit or reject proposals

**Issue 6: End-to-end real issue smoke test**
- Select a low-risk real issue
- Main agent explicitly routes to worker via `/new`
- Worker completes bounded work in its thread
- Correct reply ownership (bound worker replies in thread, or main replies if unbound)
- Acceptance: ledger, audit trail, cost attribution, thread binding, replay — all queryable from debug view

### Implementation Hard Gates

Two mechanisms that cannot be simplified during implementation:

1. **C4 outbound correlation must be atomic.** The `outbound_correlation_id` on MessageProcessing must be set in the same durable write as the outbound message. "Send first, update status later" breaks idempotency on crash.

2. **WriterLease epoch must be enforced at the store layer.** The context store itself must reject writes with stale epochs. The calling code cannot be trusted to check — the store is the enforcement point.

## Non-Goals

- Multi-machine agent distribution (all agents on one host)
- Agent migration (move an agent to a different machine)
- Agent forking (clone an agent's context)
- Cross-fleet agents (agents spanning zylos01 + zylos0t)
