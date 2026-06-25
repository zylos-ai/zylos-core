# Issue #651: SessionStart Orchestrator — Design Document

## Problem

SessionStart runs **4 independent hook commands**, copy-pasted across 3 matchers (`startup` / `clear` / `compact`) in `.claude/settings.json`:

| # | Script | Skill | Responsibility | Timeout |
|---|--------|-------|----------------|---------|
| 1 | `session-start-inject.js` | zylos-memory | Read identity/state/references → stdout | 10s |
| 2 | `c4-session-init.js` | comm-bridge | Read C4 checkpoint + recent conversations → stdout | 10s |
| 3 | `session-foreground.js` | activity-monitor | Write foreground-session.json (session_id, pid) | 5s |
| 4 | `session-start-prompt.js` | activity-monitor | Enqueue control-queue prompt via c4-control.js | 5s |

This is fragile:

- **No error isolation**: a hang in one hook (known issue #601 with `session-start-prompt.js`) blocks or corrupts the entire startup path.
- **3× duplication**: the same 4-hook list is repeated across every matcher; changes must be made in 3 places and they drift.
- **No ordering guarantee**: memory injection should logically run before C4 init (which may reference memory state), but nothing enforces this.
- **No total time budget**: if multiple hooks are slow, the aggregate startup time is unbounded.

## Goal

Replace the 4 per-matcher hook commands with a **single orchestrator script** that:

1. Is invoked once per matcher (1 command instead of 4).
2. Runs the startup steps in a defined order with per-step error isolation.
3. Enforces bounded runtime for async stalls and leaked handles, with explicit limits on what the in-process fallback can guarantee.
4. Preserves the required net behavior for each source:
   - `startup` / `clear`: memory injection, C4 init, foreground session write, and startup prompt enqueue.
   - `compact`: memory injection, C4 init, and foreground session write, but no startup prompt enqueue.

## Design

### 1. Orchestrator Script

**Location**: `skills/activity-monitor/scripts/session-start-orchestrator.js`

Placed in activity-monitor because:
- activity-monitor already owns 2 of the 4 hooks and is the system-level coordination skill.
- It avoids creating a new top-level skill just for orchestration.
- The orchestrator is a startup infrastructure concern, not a memory or communication concern.

**Interface**:

```
stdin  → JSON payload from Claude Code (session_id, source, etc.)
stdout → concatenated output from steps 1 + 2 (memory inject + C4 init)
stderr → diagnostic/error logs (not injected into context)
```

### 2. Per-Source Behavior Matrix

The orchestrator must preserve the current SessionStart behavior by source, except for the intentional `compact` prompt change:

| Source | Registered in settings? | Memory inject | C4 init | Foreground session | Startup prompt |
|--------|--------------------------|---------------|---------|--------------------|----------------|
| `startup` | Yes | Yes | Yes | Yes | Yes |
| `clear` | Yes | Yes | Yes | Yes | Yes |
| `compact` | Yes | Yes | Yes | Yes | No |
| `resume` | No | No | No | No | No |

`resume` stays unregistered. Adding `resume` would be a behavior change and should be handled as a separate decision.

### 3. Step Execution Model

```
┌─────────────────────────────────────────────────┐
│              session-start-orchestrator.js        │
│                                                   │
│  Total budget: 15s (async/handle-leak backstop)   │
│                                                   │
│  Phase 1 — Context output (sequential, stdout)    │
│  ┌───────────────────────────────────────────┐    │
│  │ Step 1: memory-inject  (budget: 6s)       │    │
│  │   Read identity/state/references → stdout │    │
│  │   On error: stderr only; stdout empty     │    │
│  └───────────────────────────────────────────┘    │
│  ┌───────────────────────────────────────────┐    │
│  │ Step 2: c4-session-init  (budget: 6s)     │    │
│  │   DB query → stdout                       │    │
│  │   On error: stderr only; stdout empty     │    │
│  └───────────────────────────────────────────┘    │
│                                                   │
│  Phase 2 — Side effects (parallel, no stdout)     │
│  ┌──────────────────┐  ┌───────────────────────┐  │
│  │ Step 3:          │  │ Step 4:               │  │
│  │ foreground.json  │  │ control-queue prompt  │  │
│  │ (budget: 3s)     │  │ (budget: 3s)          │  │
│  │                  │  │ exec timeout: 2.5s    │  │
│  └──────────────────┘  └───────────────────────┘  │
│                         skipped on source=compact │
│                                                   │
│  Flush stdout before Phase 2 and before exit       │
└─────────────────────────────────────────────────┘
```

**Why this ordering**:
- Steps 1 & 2 produce stdout that Claude Code injects as context. They must run **sequentially** because Claude reads them top-to-bottom and memory context should appear before C4 conversations.
- Phase 1 writes each successful step's bytes with `fs.writeSync(1, output)` as soon as the step completes. Errors go to stderr only; the orchestrator must not write placeholder text to stdout, because stdout is the injected context payload.
- Steps 3 & 4 produce **no stdout** (only side effects: file write + control-queue enqueue). They can run in **parallel** after context output is done.
- Step 4 is skipped when `source === 'compact'`. A compact happens mid-session; the new context still needs memory and C4 startup context, but it should not enqueue a fresh "startup / resume work" control prompt that can duplicate work or revive stale tasks.
- Total budget (15s) covers the planned worst case: Phase 1 is 6s + 6s, then Phase 2 is up to 3s in parallel. The settings hook timeout must be higher than the internal budget (recommended: 20s) so Claude's hook harness does not kill the process before the orchestrator's own cleanup and diagnostics run.

**Per-step isolation**:
- Each step runs in a `try/catch` with its own budget.
- Dynamic import happens inside that `try/catch`; a missing or broken skill module skips only that step instead of crashing the whole orchestrator.
- `AbortSignal.timeout()` is only a hard timeout for async, signal-aware work. It cannot interrupt synchronous JavaScript, synchronous filesystem calls, synchronous SQLite queries, or a synchronous infinite loop.
- The total budget `setTimeout` is a last-resort backstop for async stalls and handle-leak hangs, including the known #601 class where the event loop is still alive. It does **not** protect against synchronous event-loop blocking.
- `session-start-prompt.js` must not introduce a non-killable synchronous wait. If it shells out to `c4-control.js`, use `execFileSync` with a hard `timeout` and `killSignal`, or use async `execFile` / `spawn` with an explicit timer that kills the child process.
- Happy path must clear or `unref()` timers, remove stdin listeners, and reap any child process so the orchestrator exits naturally in under roughly 2-3 seconds instead of waiting for the 15s fallback.

### 4. Implementation Approach: Dynamic In-Process Import

Instead of spawning 4 hook child processes, the orchestrator **dynamically imports step functions inside the step runner**:

```javascript
async function runMemoryInject(payload) {
  const { injectMemory } = await import('../../zylos-memory/scripts/session-start-inject.js');
  return injectMemory(payload);
}
```

This preserves step isolation across module load failures. Static top-level imports are not acceptable here: if `zylos-memory` or `comm-bridge` is missing or throws during module initialization, a static import would crash the orchestrator before per-step `try/catch` can run.

This also requires refactoring the existing scripts to **export callable functions** alongside their CLI entry points, and to ensure import-time side effects are zero.

**What needs to be exported**:

| Script | Current | Change |
|--------|---------|--------|
| `session-start-inject.js` | `main()` is internal, writes to stdout | Export `injectMemory()` that returns string |
| `c4-session-init.js` | Top-level unconditional `main()` | Add CLI guard; export `initC4Session()` that returns string; move stdin/timer/main side effects into functions |
| `session-foreground.js` | Already exports `handleSessionForeground()` | No change |
| `session-start-prompt.js` | Top-level unconditional `main()`, calls `execFileSync` | Add CLI guard; export `enqueueStartupPrompt(source)`; move stdin/timer/main side effects into functions; add hard child-process timeout |

Each script retains its standalone CLI entry point using `if (process.argv[1] === fileURLToPath(import.meta.url))` for backward compatibility and testing. Importing any step module must be side-effect-free: no stdout writes, no control-queue enqueue, no timer registration, and no `main()` call at module load.

### 5. Settings.json Change

**Before** (4 hooks × 3 matchers = 12 entries):

This is the current standard template signature that upgrade migration should match exactly.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {"type": "command", "command": "node .../session-start-inject.js", "timeout": 10000},
          {"type": "command", "command": "node .../c4-session-init.js", "timeout": 10000},
          {"type": "command", "command": "node .../session-foreground.js", "timeout": 5000},
          {"type": "command", "command": "node .../session-start-prompt.js", "timeout": 5000}
        ]
      },
      {"matcher": "clear", "hooks": [/* same 4 */]},
      {"matcher": "compact", "hooks": [/* same 4 */]}
    ]
  }
}
```

**After** (1 hook × 3 matchers = 3 entries):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {"type": "command", "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js", "timeout": 20000}
        ]
      },
      {"matcher": "clear", "hooks": [/* same 1 */]},
      {"matcher": "compact", "hooks": [/* same 1 */]}
    ]
  }
}
```

Matchers remain separate because Claude Code dispatches different payloads per source. The orchestrator receives the source via stdin and uses it to skip prompt enqueue on compact while preserving memory injection, C4 init, and foreground-session side effects. The hook harness timeout must remain above the orchestrator's internal total budget.

### 6. Diagnostics

The orchestrator logs per-step timing to `c4-diagnostic.js` (same as today's individual hooks), plus an overall timing entry. On error, it logs:

```
[session-start-orchestrator] step "memory-inject" failed (1234ms): Error message
```

Each step log should include step name, source, status (`ok` / `failed` / `timeout` / `skipped`), duration, and whether stdout bytes were emitted. Compact prompt skip and dynamic import failures must be visible in diagnostics. This gives visibility into which step failed without breaking the startup path.

### 7. Testing

New test file: `skills/activity-monitor/scripts/__tests__/session-start-orchestrator.test.js`

Test cases:
1. **Happy path (`startup` / `clear`)**: all 4 steps run, stdout contains memory + C4 output.
2. **Step 1 failure**: memory inject throws → step 2/3/4 still run, stdout contains C4 output only.
3. **Step 2 failure**: C4 init throws → stdout contains memory output only, steps 3/4 still run.
4. **Step 3 failure**: foreground write throws → no effect on stdout or step 4.
5. **Step 4 failure**: prompt enqueue throws → no effect on stdout or other steps.
6. **Step timeout**: async, signal-aware step timeout is logged and remaining steps proceed.
7. **Prompt child timeout**: a hung `c4-control.js` child is killed by the prompt step timeout.
8. **Total timeout**: leaked handles / async stall are stopped by the 15s backstop, without corrupting stdout already flushed from completed Phase 1 steps.
9. **Import guard**: importing `c4-session-init.js` and `session-start-prompt.js` has zero side effects.
10. **Dynamic import failure**: missing/broken memory or C4 module skips only that step.
11. **Compact source**: memory inject, C4 init, and foreground write run; prompt enqueue is not called.
12. **Per-source parity**: `startup`, `clear`, `compact`, and unregistered `resume` match the behavior matrix above.
13. **Stdout byte order**: stdout is exactly memory output followed by C4 output, with no stderr diagnostics or placeholders mixed in.
14. **Happy-path exit time**: process exits naturally in under roughly 2-3s and does not wait for the 15s fallback.
15. **Migration**: standard 4-hook groups migrate idempotently; custom groups are skipped with warning; backup is written before modification; failure rolls back.

### 8. Migration

1. Refactor the 4 scripts to export callable functions (backward-compatible, CLI still works).
2. Create `session-start-orchestrator.js` that imports and runs them.
3. Add tests.
4. Update `templates/.claude/settings.json` to use the single orchestrator command.
5. Update `zylos upgrade` to migrate existing standard 4-hook settings configs into the orchestrator format.
   - Reuse or improve the existing settings migration/sync path where possible.
   - Match the standard 4-hook signature precisely by matcher, command script path, command type, and expected hook shape.
   - Make the migration idempotent and conservative: automatically migrate recognized standard hook groups, but preserve and warn on custom/non-standard hook configurations instead of blindly overwriting them.
   - Write a backup before modifying `settings.json`.
   - Ensure migration failure rolls back through the normal upgrade failure path so a failed upgrade does not leave a partially migrated `settings.json`.

### 9. Issue #652 (Codex parity)

Issue #652 asks for Codex runtime to use the same SessionStart mechanism. This is a follow-up — once #651 lands with the orchestrator, #652 becomes "wire up the same orchestrator in Codex's session init path." The orchestrator's function exports make this straightforward.

## Files Changed

| File | Change |
|------|--------|
| `skills/zylos-memory/scripts/session-start-inject.js` | Export `injectMemory()` returning string |
| `skills/comm-bridge/scripts/c4-session-init.js` | Add CLI guard; export `initC4Session()` returning string |
| `skills/activity-monitor/scripts/session-start-prompt.js` | Add CLI guard; export `enqueueStartupPrompt(source)` with hard child-process timeout |
| `skills/activity-monitor/scripts/session-start-orchestrator.js` | **New** — orchestrator |
| `skills/activity-monitor/scripts/__tests__/session-start-orchestrator.test.js` | **New** — tests |
| `templates/.claude/settings.json` | Consolidate to 1 hook per matcher; set orchestrator hook timeout above internal budget |

## Resolved Decisions

1. **Compact behavior**: `compact` must still run memory injection and C4 session init because the new compacted context needs identity/state/references plus C4 checkpoint/recent conversation context. It must skip the control-queue startup prompt because compact is an in-session context refresh, not a fresh startup/resume event.

2. **Settings migration**: `zylos upgrade` must migrate existing standard `settings.json` hooks from the 4-hook format to the 1-hook orchestrator format. Template-only updates are insufficient because existing installs would keep the old duplicated hooks. The migration should be conservative, idempotent, and rollback-safe under the normal upgrade failure handling.

3. **Hang guarantee boundary**: the design does not claim to make startup impossible to hang. It bounds async stalls, leaked handles, and killable child-process hangs. It cannot stop synchronous event-loop blocking inside the orchestrator process; implementation should minimize synchronous work in step bodies and keep the prompt enqueue child process killable.
