# Real Codex permission acceptance (opt-in)

Requires Python 3.9+, Node.js, installed repository dependencies, and an existing Codex binary. Run from any directory; `--output` must name a new evidence directory:

```sh
python3 test/integration/runtime/codex-permissions/acceptance.py \
  --codex /absolute/path/to/codex \
  --output /tmp/codex-permission-evidence
```

This fixture calls the actual `renderCodexProjectConfig` and `renderCodexGlobalConfig` exports through Node. Treatment configurations are their unchanged output. Global restrictive settings, explicit user settings, and trust-negative mutations are intentional controls. It starts real stdio app-server processes with isolated `HOME` and `CODEX_HOME`; a local deterministic HTTP Responses server persists each thread without production credentials or model requests to external services. It installs nothing and leaves production configuration untouched. Temporary configurations and sessions are retained for inspection; their location is recorded in `results.json`.

Coverage:

- Generated trusted project: new thread plus two backend process restarts, with thread-ID-only resume requests.
- Explicit legacy and named restricted user settings, and explicit workspace sandbox options, preserved.
- One-key user edits to approval and sandbox defaults.
- Generated defaults disabled and reenabled through true → false → true rendering.
- Repeated rendering is idempotent.
- Untrusted project ignores project defaults and stays restricted.
- A one-time explicit full-access API start followed by ID-only resume without persistent defaults loses full sandbox access (negative control). This represents a CLI-style override at the protocol boundary; it does not launch the TUI.

Every returned approval policy and sandbox type is asserted. Evidence contains generated config, stderr per process, requests, responses relevant to permissions, and pass status. A nonzero exit indicates failure; partial evidence is retained. The fixture uses normal app-server config parsing, matching normal CLI behavior, rather than `--strict-config`: existing unrelated generated keys may be unknown to a tested binary.

This proves renderer-to-real-backend configuration and resume behavior for the supplied binary. It does not test AM/tmux launch, TUI reconnect, managed-daemon auto-update, enterprise-managed requirements, environment-variable restoration, or OS tool execution. It is deliberately separate from the default unit suite because a real installed Codex binary is required. Both tested versions 0.159.2 and 0.160.1 passed the eleven-case matrix.
