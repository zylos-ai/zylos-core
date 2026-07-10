# state.md Format

## Purpose

What the bot is currently doing. The most frequently updated file. Answers:
"What was I working on before this session started?"

## Loading

Always loaded at session start via SessionStart hook.

## Size Guideline

Target ≤10KB (warn threshold, reported as WARN by `memory-status.js`);
hard budget 16KB. This file is in every session's context. Every line must
earn its place. A healthy instance sits well under the warn threshold —
sustained growth past it means completed-task narrative or history is
accumulating and the content rules below are being violated.

## Update Frequency

Every memory sync. Also updated proactively when work focus changes.

## Sections

| Section | Content |
|---------|---------|
| `Last updated` | YYYY-MM-DD HH:MM timestamp |
| `## Current Focus` | 1-3 sentences on active work |
| `## Pending Tasks` | Checklist with requester and date |
| `## Recent Completions` | Recently finished items with date |

See `examples/state.md` for a full example.

## Content Rules

state.md answers "what am I doing right now" — it is not a project log.

### Allowed

- Current focus: status + next step + a pointer to the file holding the
  full detail (`reference/projects.md`, a workspace path, an issue ID)
- Genuinely pending items: not-yet-done tasks with requester and date
- Blocker/waiting notes: what is blocked, on whom, since when

### Disallowed — route instead of accumulating

| Content class | Route to |
|---------------|----------|
| Completed-task narrative (how it was done, verification detail) | `reference/projects.md`; collapse to a one-line ✅ in state.md, or delete |
| Decision records and rationale | `reference/decisions.md` |
| Run history, superseded attempts, obsolete detail | `archive/` |
| Content already held in an on-demand file | replace with a pointer to that file |

### Rules

1. Keep it lean -- this is the tightest budget file.
2. Move completed tasks out promptly (to session log or reference files).
   A finished item earns at most one ✅ line; the story of how it finished
   does not belong here.
3. Pending tasks should include who requested and when.
4. Current Focus should reflect the most recent work, not a backlog.
   Point to detail files instead of inlining detail.
5. One-off tasks belong here, not in `reference/projects.md`.
6. Memory Sync audits this file against these rules on every sync
   (see SKILL.md Sync Flow): violations are relocated, not left in place.
