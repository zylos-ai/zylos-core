# Antigravity runtime

Zylos supports Antigravity CLI (`agy`) as a tmux runtime using a Gemini API key.
Install the CLI from Google's official distribution first, then prepare Zylos
with `zylos init --runtime agy`. Set `GEMINI_API_KEY` in the instance environment
or save a key when switching:

```sh
zylos runtime agy --save-apikey <key>
zylos runtime status
```

Personal Google AI Pro/Ultra subscription login and Vertex are unsupported.
Authentication validation uses the Gemini models HTTP endpoint; `agy models`
does not establish that a key is valid. The HTTP probe sends its key in a header
and returns only fixed status reasons. The bounded curl probe uses the saved
HTTPS_PROXY setting used for runtime launch. Authentication checks require `curl`
on `PATH`. If it is missing, the check returns `uncertain` and `zylos runtime agy`
reports `AUTH_NOT_CONFIRMED`; make curl available before retrying. Do not paste
keys into issue comments.

An explicit key rejection returns `AUTH_FAILED` from both `zylos auth agy`
and `zylos runtime agy`. A Stop hook reporting HTTP 401/403 or an explicit
invalid API key error records `auth_failed`; other system errors remain
`unavailable`.

The per-HOME setup merges Gemini provider settings, a Zylos statusLine command,
Zylos hook entries with explicit 60-second timeouts and the memory MCP server.
Other named hook and MCP entries are retained. Onboarding completion is prewritten
and interaction data collection is disabled. Launch also selects the Gemini
provider and workspace trust explicitly without changing global trust settings.
Each launch prepares the agy configuration before tmux starts, including the first
launch through a group runtime override. A missing API key fails before setup.
The `PreToolUse` hook denies `ask_question` with a plain-text questioning
alternative, preventing an unattended session from opening a keyboard dialog.

A launch kick triggers SessionStart before the first model turn. SessionStart
injects the complete system and user instructions as `injectSteps` JSON. The
shared AGENTS.md is the same complete file used by Codex; agy never replaces
it with a runtime-specific entry. Its common body ends with separate Codex and
Antigravity sections; each runtime follows only its own section. Injected
instructions explicitly take precedence
when runtime-specific directions differ from that auxiliary file.
`/clear` receives another kick; `/exit` quits. Every message uses bracketed paste.
The router locates the framed input around the cursor, including when background
task panels appear below it. It requires an empty input before pasting and rejects
slash menus and trust choices. Claude and Codex retain their existing transport behavior.

PreInvocation starts a busy turn and fully-idle Stop ends it. StatusLine state
handles interrupted turns and background resumption, with a 500ms stability
interval covering short gaps between queued requests. ERROR termination marks
the runtime unhealthy. Context rotation uses the native percentage and the 1M
window policy; transcript locations come from hooks, not statusLine.

This initial integration excludes model/effort overrides, dedicated screen-text
health patterns, `/compact`, Dashboard history/cost views and transcript billing.
Real-model acceptance must run in an isolated instance with a private tmux socket.

## Shared instructions and native rule limits

Both runtimes build the same full AGENTS.md from the same split layers and
assembler. Before split activation, both leave the existing file unchanged.
Zylos emits the complete instructions synchronously through SessionStart,
regardless of the source file length. The same injection path accepts an existing
legacy AGENTS.md larger than 24,000 bytes.

Google's [rules documentation](https://antigravity.google/docs/rules) describes
24,000-byte truncation per rule file and a 20,000-token total for always-on rules;
the largest files become on-demand pointers when that total is exceeded. Whether
hook injection avoids these native rule limits requires real-model acceptance.
The release checks include a roughly 27KB injected tail marker and simultaneous
Codex/agy groups in one root, each restarted for three rounds, followed by agy
`/clear` and another tail-marker check.
