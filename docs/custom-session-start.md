# Custom Session-Start Directives

`~/zylos/custom-hooks/session-start/` lets an operator (or an installing platform) inject standing directives into **every** agent session — machine- or deployment-local rules that must be in force from the first moment of a session, without anyone asking. Typical content: toolchain constraints ("always use the GVM-managed Go, never system Go"), platform policies, house rules.

This is a **content** directory, not a code hook: files are plain markdown, read fresh at each session start by fixed core code (`skills/activity-monitor/scripts/emit-custom-inject.js`). Users supply content, never code.

## Location and layout

```
~/zylos/custom-hooks/
└── session-start/          # content for the session-start injection point
    ├── 10-go-toolchain.md
    └── 20-platform-rules.md
```

The hook-scoped layout (`custom-hooks/<hook-name>/`) leaves room for future hook types to get their own content subdirectory; `session-start` is the only one today.

## Semantics

- **When it fires:** at every session start — fresh startup, after `/clear`, and after context compaction. The content is (re)injected each time, so it survives context rotation.
- **Where it lands:** as the numbered shard right after the identity shard (`=== ZYLOS STARTUP CONTEXT [2/N] custom ===`), so custom directives frame everything that follows (references, state, conversation context).
- **Ordering:** files concatenate in lexicographic filename order, conf.d style — use numeric prefixes (`10-`, `20-`, ...) to control precedence.
- **What is read:** entries whose **name** ends in `.md`; dotfiles and other extensions are ignored. The filter is name-based only — **a symlink named `*.md` is followed and its target's content is injected**, so only link to files you own and intend to inject, never to anything that may hold sensitive content. An unreadable file is skipped (it never breaks session start).
- **How content lands:** each file's content is trimmed of leading/trailing whitespace; non-empty files are concatenated with one blank line between them (not byte-for-byte verbatim).
- **Empty states:** a missing directory, no `.md` files, or all-empty content emits just the shard header — chain and numbering are unaffected.
- **No lifecycle steps:** no registration, no config entry, no service restart. Create/edit/delete files; the next session start picks the change up.

## Budget

Each shard has a per-shard budget (default 10,000 chars / ~2,200 estimated tokens — see `shard-registry.js`). Content over budget is tail-trimmed inline, with a notice pointing at a spill file holding the full text. Practically: keep this directory far below the budget — every line here is a **permanent per-session token cost**, paid on every startup, `/clear`, and compaction.

## What belongs here (and what doesn't)

| Content | Home |
|---------|------|
| Deployment/machine-local standing directives, active every session | `custom-hooks/session-start/` |
| Who the agent is (personality, principles, assets) | `memory/identity.md` (agent-maintained) |
| Working conventions consulted on demand | `memory/reference/preferences.md` |
| Facts, history, work state | `memory/` (state, references, reference/, sessions) |
| Cross-deployment behavior shipped to every install | `ZYLOS.md` core template |
| Complex reusable task-triggered workflows | a skill |

Ownership boundary: `memory/` is agent-written and audited/trimmed/archived by Memory Sync. `custom-hooks/` is operator-placed configuration — the agent does not manage it, and writes here only when explicitly asked to make a rule permanent for every session.

## Pitfalls

- **Never place explanatory/readme `*.md` files inside the directory.** Every `.md` file there is injected into every session — a readme becomes a permanent token tax. Put documentation outside the directory (like this file), or use a non-`.md` filename/dotfile, which the emitter ignores.
- **Symlinks are followed.** A `*.md` symlink injects its target's content into every session. This supports sharing directive files across deployments (conf.d style), but note what it does to the security boundary: injected content is controlled by write access to the directory **and to every reachable symlink target (and its path)** — anyone who can modify or replace a link target changes what the next session start injects. Only symlink files you own and control; never link anything that may contain secrets or content you don't control.
- Do not duplicate content that already lives in `memory/` or ZYLOS.md — the directory should hold only directives that genuinely need always-on injection.

## Example

```bash
mkdir -p ~/zylos/custom-hooks/session-start
cat > ~/zylos/custom-hooks/session-start/10-go-toolchain.md <<'EOF'
# Go toolchain (this machine)

Always use the GVM-managed Go toolchain (`gvm use go1.22`); never invoke the
system Go. Go builds and tests must run through the GVM environment.
EOF
```

From the next session start onward, the directive arrives in the `[2/N] custom` shard of the startup context.
