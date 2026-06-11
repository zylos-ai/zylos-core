---
name: multi-session
description: Multi-session runtime (phase 1) — delegate bounded work to agent-teams teammates. Use when delegating a task to a worker session, preparing a teammate prompt, checking/installing teammate permission guardrails, accepting or failing a worker's delivery, or harvesting in-flight workers before molt (/clear).
---

# Multi-Session Runtime (Phase 1 — Delegated Work Sessions)

Phase 1 of the multi-session runtime (design: multi-session-runtime-proposal-v2.1).
Scope: **session registry + team adapter only**. The worker carrier is native
Claude Code agent teams — the lead (main interactive session) spawns teammates
itself via its native tools. This skill does bookkeeping and conventions, not
process spawning. C4 comm-bridge, activity-monitor, scheduler, and runtime
switching: **zero changes**.

Data lives in `~/zylos/multi-session/`:
- `registry.json` — persistent worker registry (atomic writes; survives molt)
- `deliveries/<date>-<slug>/` — per-task delivery directories

## CLI

`~/zylos/.claude/skills/multi-session/scripts/cli.js <command>`

| Command | Description |
|---------|-------------|
| `delegate-prep <task-slug> [--task "<desc>"]` | Create delivery dir, register worker, print teammate prompt. Refuses at cap. |
| `accept <id> [--summary "<text>"]` | Accept a worker's delivery |
| `fail <id> [--reassign]` | Mark failed; `--reassign` creates a successor entry on the same delivery dir |
| `harvest` | List in-flight workers; **exit 1 if any exist** (run before molt) |
| `check-guardrails [--project-dir <dir>]` | Verify teammate deny block in `<dir>/.claude/settings.json` |
| `write-guardrails [--project-dir <dir>]` | Install/merge the deny block |
| `list` / `get <id>` / `active` / `add` / `update <id>` / `done <id>` | Registry CRUD |

## Delegation Lifecycle

1. **Prep:** lead runs `delegate-prep <slug> --task "<full description>"`. The
   adapter enforces the concurrency cap, creates
   `~/zylos/multi-session/deliveries/<date>-<slug>/`, registers a `pending`
   worker, and prints a ready-to-use teammate task prompt (goal, boundaries,
   delivery dir, continuous-checkpoint requirement, down-scoping notes).
2. **Spawn:** the lead spawns the teammate with its native agent-teams tools,
   pasting the printed prompt. Ensure the teammate's working directory passes
   `check-guardrails` first (run `write-guardrails` if not). Then
   `update <id> --status running --teammate <name> --team <name>`.
3. **Checkpoint:** the teammate continuously checkpoints progress into the
   delivery dir. Teammates are **not resumable** — the delivery dir is the only
   surviving context if the worker dies.
4. **Completion:** teammate writes `RESULT.md` in the delivery dir and reports
   to the lead; lead runs `done <id> --summary "..."`.
5. **Acceptance:** lead verifies the delivery, then `accept <id>`. On failure:
   `fail <id> --reassign` creates a successor entry linked to the same delivery
   dir so the next teammate resumes from the checkpoints.

## Tool Down-Scoping (Guardrails)

Teammates must not write zylos memory or impersonate the main session
externally. The deny block must live in the **project `.claude/settings.json`
of the cwd the teammate runs in** — that is where teammates inherit it from:

```json
{
  "permissions": {
    "deny": [
      "Write(//home/<user>/zylos/memory/**)",
      "Edit(//home/<user>/zylos/memory/**)",
      "Bash(*c4-send.js*)",
      "Bash(*c4-control.js*)"
    ]
  }
}
```

**IMPORTANT:** absolute paths in permission rules MUST use the `//` prefix.
A single `/` silently fails to match (spike-verified 2026-06-12).
`write-guardrails` generates this block; `check-guardrails` verifies presence
and flags single-slash absolute paths.

## Caveats and Hard Rules

- **Lead-lifecycle coupling (spike-verified 2026-06-12):** teammates are
  managed by the lead process and **die with the lead**. Molt (/clear), restart,
  or crash of the main session takes all teammates down. Therefore the molt
  procedure must run `harvest` first and only molt on exit code 0 — otherwise
  accept, fail, or explicitly reassign in-flight workers ("harvest before
  molt"). The registry persists across molt; unfinished work is reassigned at
  task granularity from the delivery-dir checkpoints.
- **Hard cap N=2 concurrent workers** (prior decision 2026-06-09). Enforced in
  `delegate-prep`: it refuses (exit 2) when 2 workers are active
  (pending/running). Keep workers short-lived — delegate, harvest, release.
- **Explicit-budget rule:** headless `claude -p` workers are billed on a
  separate credits pool (post 2026-06-15 policy), NOT the subscription pool.
  `-p` is never the default path — escalating to it is always an explicit
  budget decision. Phase 1 uses agent teams (subscription pool) only.
- Worker token usage should be recorded in the registry (`update <id> --usage`)
  for subscription-window watermark decisions.
