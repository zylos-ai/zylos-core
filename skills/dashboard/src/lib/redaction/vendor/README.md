# Pinned detection rules

The rule files are declarative data. No validators, network requests, or vendor code execute at runtime.

- Gitleaks: MIT, tag `v8.30.1`, last rule change `09242ce9c8a60d9b051fc2d166f9e849b88c7ac0`. Full TOML git blob: `256f64790ea6d954f0041024be2938089ae1e7a7`. Source: https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml . 222 definitions; one path-only rule is excluded because history scans text.
- Betterleaks: MIT, commit `530e3304d96b604bbabb7dde19bb38bda8db5cae`. Full upstream TOML git blob: `30114dca723f658231a20e9238bc2de5d67b9bd7`. Source: https://github.com/betterleaks/betterleaks/blob/530e3304d96b604bbabb7dde19bb38bda8db5cae/config/betterleaks.toml . `betterleaks-extra.toml` contains exact upstream blocks for DeepSeek, Groq, Kimi, MiniMax, OpenRouter, and xAI, all high-confidence with fixed secret prefixes. DeepSeek/Kimi also require vendor context. Mistral is medium-confidence and Lark secret has no fixed prefix, so neither is selected. Generic key-name/L1 rules cover their credential fields.

Betterleaks validator expressions remain inert upstream data. The selected six rules use only the entropy filter, which the build translates. Unsupported filters cause the build to fail rather than silently drop semantics. No other Expr features are ported.

## Rebuild

Run `node scripts/build-redaction-rules.js` with the repository's pinned development dependencies (`smol-toml` 1.9.0, `regexpu-core` 6.4.0). An isolated development module directory can be supplied with `REDACTION_BUILD_MODULE_DIR`. Commit the generated module and review its diff. Runtime imports only generated JavaScript and Node built-ins.

The build converts RE2 anchors/POSIX classes/inline flags, removes the known pathological leading bounded context prefix, expands scoped modifiers using regexpu-core, and compiles every resulting expression. Path allowlists do not apply to transcript text. Text allowlists preserve entropy, secret groups, regex targets, and OR/AND semantics.

The L2 redaction detector shares Fleet's credential pattern but omits word boundaries, so credentials appended directly to ordinary text are also masked. Its markers intentionally omit the Dashboard token prefix/field-name vocabulary to pass the unchanged Fleet guard. Other vendors retain only a known public fixed prefix.

The async engine refreshes known values by file metadata once per structured traversal, uses an in-memory bounded LRU containing redacted results only, and runs every uncached string in one reusable worker with a 5-second deadline covering queue time and execution; bursts wait in the queue instead of being rejected at a fixed job count. Failure returns an unavailable marker. A deadline terminates the stuck worker; queued work resumes with a replacement. L1 known values require at least eight characters and reject placeholders, booleans, numbers, and code expressions. Session identifiers and bare `key`/`auth` metadata are not L4 credential names. Caller-provided allowlist entries are exact secret values and never bypass L2.
