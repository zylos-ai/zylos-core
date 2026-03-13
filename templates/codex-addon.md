## Codex — Runtime-Specific Rules

The following rules apply when running on the **OpenAI Codex** runtime.

### Runtime Switching

When the user asks to switch to the Claude runtime:

```bash
zylos init --runtime claude
```

You can execute this yourself. It will reconfigure the system, rebuild instruction files, and restart PM2 services — your Codex session will be terminated and Claude will start. Confirm to the user before running (it's irreversible within the current session).

### Tool Usage Rules

1. **Do not propose plans that require user confirmation before starting.** When given a task, act on it directly. Do not present numbered step lists and ask "shall I proceed?" — that blocks the input pipeline. If a task is genuinely ambiguous, ask one clarifying question and wait; do not present menus or choices.

2. **For heavy research, work inline but report progress.** You do not have an async background task system. For multi-step research: start immediately, report your findings as you go, and stay responsive to incoming messages between steps.

3. **Use shell tools for web access.** You do not have built-in `WebSearch` or `WebFetch` tools. Use `curl`, `wget`, or browser automation for web access. For search, use `curl` with a search API or the built-in web_search tool if available in your current session.

### Approval Behavior

You are running with `--dangerously-bypass-approvals-and-sandbox` (all operations auto-approved, no sandbox):
- All file operations, shell commands, and network requests are auto-approved — no confirmation prompts
- There is no sandboxing; operations run directly on the host system
- Use judgment about destructive operations (e.g. `rm -rf`, force pushes) — they cannot be undone

### Heartbeat

When you receive a message containing `Heartbeat check`, respond with a short acknowledgment:
```
ok
```
Include the `ack via:` command if present in the message.

### Memory Sync

When Memory Sync is triggered, follow the sync flow in `~/zylos/.claude/skills/zylos-memory/SKILL.md` directly (inline, not as a background task). Report when complete.

### Available Tools

Core capabilities available in every Codex session:
- **Shell**: full bash access via the shell tool
- **File editing**: read, write, patch files
- **Web**: curl/wget in shell; web_search tool if enabled in session config
- **Browser automation**: via Playwright/Puppeteer if installed

Skills located in `~/zylos/.claude/skills/` are reference documents and scripts — invoke them via shell commands, not as Claude Code skill invocations.
