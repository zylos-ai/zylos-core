---
name: restart-claude
description: Use when the user asks to restart the agent runtime (Claude Code, Codex or Antigravity), or after changing runtime settings/hooks/keybindings.
---

# Restart Runtime Skill

Request a runtime restart through the Supervisor. The dispatcher starts replacement sessions after safe reclamation.

## When to Use

- After changing runtime settings, hooks, or keybindings
- When the runtime needs to reload configuration
- To clear temporary state without upgrading
- User explicitly asks to restart

## Pre-Restart Checklist

Before requesting the restart, complete these steps **in order**:

### 1. Stop background tasks

Check for running background agents or subagents. If any are active, stop them to avoid orphaned work.

### 2. Save the scoped handoff

Follow the system's Handoff Follow-up instructions. Save the current scope's
`handoff.md` atomically with the unfinished work, blockers, and next steps.
Verify the saved file before proceeding.

### 3. Send the handoff summary

Send the full handoff summary to the internal `void` channel via C4:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "void" "session-handoff"
<handoff summary>
EOF
```

The `void` channel records the summary in C4 history. The scoped `handoff.md`
is what the replacement session reads to resume work.

Do not send the full handoff summary to the active external user channel
(Telegram, Lark, Feishu, HXA, etc.). Handoff summaries are operational context
for the next agent session and may contain task state from outside the current
conversation. If the user is actively waiting, send only a short user-facing
notice to their current `reply via` path, without internal task inventory or
cross-channel context.

### 4. Submit the restart

```bash
node ~/zylos/.claude/skills/restart-claude/scripts/restart.js --json
```

The script submits `restart_all` to the supervisor in every session mode.
The supervisor snapshots the running group sessions and gives each up to 60
seconds to check work waiting on external events before restarting it. An empty
snapshot returns `done_empty`. The script reports refusal or uncertainty
without automatically resubmitting. Acceptance means the request was recorded.
Replacement sessions report readiness separately.
