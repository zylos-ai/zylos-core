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
and returns only fixed status reasons. Do not paste keys into issue comments.

The per-HOME setup merges Gemini provider settings, a Zylos statusLine command,
Zylos hook entries with explicit 60-second timeouts and the memory MCP server.
Other named hook and MCP entries are retained. Onboarding completion is prewritten
and interaction data collection is disabled. Launch also selects the Gemini
provider and workspace trust explicitly without changing global trust settings.

A launch kick triggers SessionStart before the first model turn. SessionStart
injects the complete system and user instructions as `injectSteps` JSON. The
AGENTS.md entry stays under 24,000 bytes; complete rules arrive through the hook.
`/clear` receives another kick; `/exit` quits. Every message uses bracketed paste.
The router requires an empty framed input before pasting, rejecting slash menus
and trust choices. Claude and Codex retain their existing transport behavior.

PreInvocation starts a busy turn and fully-idle Stop ends it. StatusLine state
handles interrupted turns and background resumption, with a 500ms stability
interval covering short gaps between queued requests. ERROR termination marks
the runtime unhealthy. Context rotation uses the native percentage and the 1M
window policy; transcript locations come from hooks, not statusLine.

This initial integration excludes model/effort overrides, dedicated screen-text
health patterns, `/compact`, Dashboard history/cost views and transcript billing.
Real-model acceptance must run in an isolated instance with a private tmux socket.

## Mixed-runtime limitation under review

Codex and Antigravity currently share the root AGENTS.md. Starting Codex after
Antigravity regenerates the full Codex entry; Antigravity still receives all
instructions from its hook, but the shared file may then exceed 24,000 bytes.
Conversely, Antigravity replaces it with its short entry. This implementation
therefore proves the bounded-file requirement for an isolated agy instance,
not simultaneous Codex/agy groups in one root. Resolve that ownership contract
before approving mixed-runtime production use. No unverified instruction-file
setting or additional workspace mirror is introduced.
