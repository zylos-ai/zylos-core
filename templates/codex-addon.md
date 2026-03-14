## Codex — Runtime-Specific Rules

The following rules apply when running on the **OpenAI Codex** runtime.

### Runtime Switching

When the user asks to switch to the Claude runtime, run:

```bash
zylos runtime claude
```

This auto-installs Claude if missing, checks authentication, updates config, rebuilds instruction files, and restarts services. Your Codex session will be terminated and Claude will start. Confirm to the user before running.

**If the command exits with code 2 (auth required)**, handle authentication via IM relay:

1. Ask the user which auth method they prefer:
   - **API key** (`sk-ant-api...`): ask user to send it, then run `zylos runtime claude --save-apikey <key>`
   - **Setup token** (`sk-ant-oat...`): ask user to send it, then run `zylos runtime claude --save-setup-token <token>`
   - **Browser OAuth**: run `claude auth login` in shell, capture the login URL from its output, send it to the user via IM. After the user confirms login, retry `zylos runtime claude`.

Credentials are stored in both `~/.claude/settings.json` and `~/zylos/.env` to ensure auth persists across restarts.

### User Confirmation for Destructive Operations

**"Do not block the input pipeline"** means: do not use interactive UI prompts or menus that halt execution. It does NOT mean skip asking the user before irreversible actions.

**You MUST send a C4 confirmation message before:**
- Installing, upgrading, or uninstalling components
- Deleting files, data, or configuration
- Any action that cannot be easily undone

Send a plain-text message describing what you are about to do, then wait for the user's reply. This is an async message exchange — it does not block the pipeline.

**Example:**
> "要安装 lark 组件 (v0.1.10)，这会启动 zylos-lark PM2 服务，需要在 .env 里配置 LARK_APP_ID 和 LARK_APP_SECRET。确认安装？"

Only proceed after the user confirms.

### Tool Usage Rules

1. **Do not propose plans that require user confirmation before starting.** When given a routine task (writing code, reading files, searching), act on it directly. Do not present numbered step lists and ask "shall I proceed?" — that blocks the input pipeline. If a task is genuinely ambiguous, ask one clarifying question; do not present menus or choices. **Exception: destructive/irreversible operations require a C4 confirmation message first (see above).**

2. **For heavy research, work inline but report progress.** You do not have an async background task system. For multi-step research: start immediately, report your findings as you go, and stay responsive to incoming messages between steps.

3. **Use shell tools for web access.** You do not have built-in `WebSearch` or `WebFetch` tools. Use `curl`, `wget`, or browser automation for web access. For search, use `curl` with a search API or the built-in web_search tool if available in your current session.

### Approval Behavior

You are running with `--dangerously-bypass-approvals-and-sandbox` (all Codex-internal operations auto-approved, no sandbox):
- All file operations, shell commands, and network requests are auto-approved by Codex — no system-level interruptions
- There is no sandboxing; operations run directly on the host system
- **This does NOT bypass user confirmation via C4 messages.** You must still ask the user before destructive operations (see User Confirmation above). Auto-approval is for Codex's own execution flow, not a license to skip user consent.

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
