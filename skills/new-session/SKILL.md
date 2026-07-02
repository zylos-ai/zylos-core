---
name: new-session
description: Start a new session when context is high. Claude uses /clear, Codex uses /exit. Use when context is high or when a fresh session is needed.
---

# New Session Skill

Start a fresh session with graceful handoff.
Use runtime-specific switch commands:
- Claude: `/clear`
- Codex: `/exit`

## When to Use

- Context usage exceeds the runtime threshold (triggered automatically by context monitoring)
- User explicitly asks for a new session or context reset
- When you need a clean context but don't need to reload settings/hooks (use restart-claude for that)

## Pre-Switch Checklist

Before sending the session switch command, complete these steps **in order**:

### 1. Inventory running background tasks

Check for running background agents using the current runtime's available agent/task listing capability. For Claude, this is `TaskList`.

Runtime behavior differs here:
- **Claude**: background subagents survive `/clear`, so do not stop them.
- **Codex**: `/exit` terminates background tasks. Before enqueueing `/exit`, make sure required background work has finished.

For each running task, note:
- **Agent ID** (e.g., `a42c1aabc5b984e69`)
- **What it's doing** (brief description)
- **Output file path** (so the new session can check on it)

This information goes into the handoff summary (step 2).

### 2. Write a session handoff summary

Write a brief message covering:
- **What was being worked on** (active tasks, user requests in progress)
- **Current state** (what's done, what's pending, any blockers)
- **Running background tasks** (from step 1 — include agent/task IDs and any output file paths or result handles so the new session can check on them with the runtime-appropriate output mechanism)
- **What the next session should pick up** (if anything)

### 3. Send the handoff summary

Send the full handoff summary to the internal `void` channel via C4:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "void" "session-handoff"
<handoff summary>
EOF
```

The `void` channel is record-only: the message is stored in C4 conversation
history (so the new session's startup hook, `c4-session-init`, includes it in
startup context) but is never delivered to any real channel or display
surface.

Do not send the full handoff summary to the active external user channel
(Telegram, Lark, Feishu, HXA, etc.). Handoff summaries are operational context
for the next agent session and may contain task state from outside the current
conversation. If the user is actively waiting, send only a short user-facing
notice to their current `reply via` path, without internal task inventory or
cross-channel context.

### 4. Enqueue Session Switch Command

For Codex:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/exit" --priority 1 --block-queue-until-idle --no-ack-suffix
```

For Claude:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/clear" --priority 1 --block-queue-until-idle --no-ack-suffix
```

## How It Works

1. **Early memory sync** (handled by context-monitor, not this skill): At 80% of the session-switch threshold, the context monitor triggers memory sync in the background. The new session's startup hook also checks for unsummarized conversations and triggers sync if needed — so memory sync is never lost, at most delayed by one session.
2. **Pre-switch checks**: Inventory background tasks, write handoff summary.
3. **Enqueue switch command**: Puts the runtime-specific command into the control queue (`/clear` for Claude, `/exit` for Codex)
4. **Deliver when idle**: Dispatcher delivers the command when idle
5. **Session switches**:
   - Claude: `/clear` resets conversation context, session-start hooks fire, and background subagents continue independently
   - Codex: `/exit` exits the current session so a fresh one can start
6. **New session**: Session-start hooks fire, including memory sync if unsummarized conversations exceed threshold.
