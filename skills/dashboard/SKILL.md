---
name: dashboard
version: 0.6.9
description: Zylos observability dashboard with a conversation channel for agent state, costs, tools, communication, scheduler, and PM2 service health. Full features on Claude runtime. PM2, system health, communication, and scheduler monitoring on all runtimes.
type: capability

c4:
  delivery: stdin
  before_send:
    hook_id: dashboard.content
    entry: scripts/send-hook.js
    timeout_ms: 1500

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dashboard
    entry: src/index.js
  data_dir: ~/zylos/components/dashboard
  preserve:
    - config.json
    - dashboard.db
    - spool/
    - backups/
  next-steps: "Dashboard is bundled with Core. Upgrade with zylos upgrade --self; Core owns activity hooks."

http_routes:
  - path: /dashboard/*
    type: reverse_proxy
    target: 127.0.0.1:3470
    strip_prefix: /dashboard

config:
  required: []
  optional:
    - name: DASHBOARD_PORT
      description: Dashboard server port
      default: "3470"
    - name: DASHBOARD_HOST
      description: Dashboard bind address
      default: "127.0.0.1"
    - name: DASHBOARD_AUTH_PASSWORD
      description: Dashboard login password (independent from Web Console; generated on first install and never printed)
      sensitive: true


---

# Zylos Dashboard

Observability dashboard for a local Zylos agent, with a Dashboard conversation channel.

## Conversation channel

The Dashboard channel requires Core support for channel-declared synchronous
BeforeSend hooks and post-storage stdin delivery. Deploy the matching Core and
Dashboard capabilities together; an older argv-only Core cannot deliver this
channel. This declaration does not add a separate service or registration step.

Send plain text through the C4 send entry, using the original conversation ID as
the endpoint and its local group name when replying within that group:

```bash
cat <<'EOF_MESSAGE' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js dashboard conversation_a --session-group conversation_a
Your plain-text reply.
EOF_MESSAGE
```

Use the exact endpoint/group from the originating conversation; display names do
not select a destination. Do not call the low-level `c4-db.js insert` command for
Dashboard sends: it bypasses BeforeSend. Core stores the original text, then
passes the six-field delivery packet to `scripts/send.js` on stdin; the script's
argv does not carry the message body. Callers do not construct this packet.

The synchronous hook permits unmarked text up to 65,536 UTF-8 bytes, including
ordinary JSON and Core status notices. Content beginning with the exact shared
`[C4-CONTENT]` plus LF prefix must pass the shared C4 envelope parser: version,
block types, actions, fields and known Core suffix rules are validated without
rewriting the original content. Malformed envelopes and any oversized message
are rejected before storage or channel delivery. See Core's
`docs/c4-content-protocol.md` for the envelope contract and examples.

After the stored row is verified, an interactive message is registered with its
original group, C4 reference, question summary, constraints and paused state.
Repeated delivery of the same C4 reference preserves the existing record and
its current state. A different C4 row reusing the same group and interrupt ID
fails registration; its content remains stored and read-only, and does not
replace the original question. If registration fails, the message is already stored in C4 and remains visible
as read-only content. Do not resend it. Repair must use the same C4 reference;
this release does not provide a product entry point for that repair. The repair
entry point belongs to subsequent work.
Answers, stop/replace control envelopes and noninteractive messages do not
register or change questions in this channel receiver. Answering and lifecycle
controls are separate capabilities.

A successful send confirms the stored row and channel handoff; it does not prove
that a person viewed the text. Dashboard delivery reads the authoritative C4 row
by its ID using a read-only connection and does not call back into Dashboard HTTP.
Plain-text and noninteractive delivery do not open the Dashboard database.
Question registration writes only to Dashboard's database after the C4 readback;
it never writes C4 or creates a second message/head.

Release prerequisites (verify actual installed versions before deployment):

| Component | Minimum version |
| --- | --- |
| Core | TBD — finalized with Core release (待定，随 Core 定版); must include shared envelope parsing, all model/history readers migrated to projection, BeforeSend and stdin delivery |
| identity-reflection | TBD — finalized with Core release (待定，随 Core 定版); must include the reviewed projected-history adapter |
| thinking-patterns | TBD — finalized with Core release (待定，随 Core 定版); must include the reviewed projected-history adapter |

These are release requirements. No automatic capability detector or runtime
disable switch substitutes for verifying the deployed versions.

## Dashboard service

```bash
npm start
```

Default URL: `http://127.0.0.1:3470/`

A new installation creates an independent random password hash without printing
the password. Before first sign-in, set an owner-chosen Dashboard password through
the existing `hooks/configure.js` stdin JSON interface: supply
`DASHBOARD_AUTH_PASSWORD` as the scrypt value produced by
`hashPassword` from `src/lib/auth.js`. Point `ZYLOS_DATA_DIR` at this instance's
`components/dashboard` directory. Keep the plaintext in memory, out of command
arguments, files and logs; the configure input and saved config contain only the
hash. Restart Dashboard after changing its configuration. Existing installations
keep their configured password. Dashboard does not share Web Console credentials.

For optional terminal viewing, supported platforms and cleanup recovery, see
[Observer](docs/observer.md). Observer automatically selects the target Dashboard
host's platform: macOS Apple Silicon, Linux x64 or Linux ARM64. Install and enable
it from Settings; the linked guide lists host requirements and cleanup behavior.
