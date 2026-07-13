# Runtime Switch — Authentication Relay Playbook

Read this when `zylos runtime <target>` exits with **code 2 (auth required)**.
The switch command itself (confirmation etiquette, what it does, transition
notice) is covered by the system instructions; this file holds the full
per-target authentication relay scripts.

Credentials are always stored in **two places** so auth persists across
restarts: the runtime's own credential store and `~/zylos/.env`.

## Switching to Codex (`zylos runtime codex` exits 2)

Ask the user which auth method they prefer. API key is fastest; device auth
is a good fallback if the user has no API key. Example message:

> "Codex authentication required:
> 1. **API Key** (recommended, fastest): send me your OpenAI API key (sk-...) and I'll configure it
> 2. **Device auth** (no API key): I'll start the auth flow and send you a link to complete
> 3. Browser login
> Which one?"

- **Option 1 — API key**: user sends the key, run `zylos runtime codex --save-apikey <key>`
- **Option 2 — Device auth**: run `codex login --device-auth` in shell, capture the URL/code, send to user via IM. After user confirms completion, retry `zylos runtime codex`.
- **Option 3 — Browser login**: run `codex login` in shell, capture the login URL if available, send to user via IM.

Codex credentials live in `~/.codex/auth.json` and `~/zylos/.env`.

## Switching to Claude Code (`zylos runtime claude` exits 2)

Ask the user which auth method they prefer. API key is fastest; setup token
is a good fallback for automated setups. Example message:

> "Claude authentication required:
> 1. **API Key** (recommended, fastest): send me your Anthropic API key (sk-ant-api...) and I'll configure it
> 2. **Setup Token** (for automated setups): send me your setup token (sk-ant-oat...) and I'll configure it
> 3. Browser OAuth login
> Which one?"

- **Option 1 — API key**: user sends the key, run `zylos runtime claude --save-apikey <key>`
- **Option 2 — Setup token**: user sends the token, run `zylos runtime claude --save-setup-token <token>`
- **Option 3 — Browser OAuth**: run `claude auth login` in shell, capture the login URL, send to user via IM. After user confirms, retry `zylos runtime claude`.

Claude credentials live in `~/.claude/settings.json` and `~/zylos/.env`.

## After authentication succeeds

Retry the original `zylos runtime <target>` command. Once it completes, send
a brief transition notice — keep it short, as the new runtime will send its
own ready message. Do NOT mention `zylos attach` (that is for terminal users
only). Example:

> "Switching now, should be ready in about 10 seconds."
