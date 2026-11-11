---
name: dashboard
version: 0.6.9
description: Zylos observability dashboard and Dashboard conversation channel. Use when replying to a Dashboard conversation (the reply-via route names the dashboard channel), when sending charts, choice cards, forms or other structured content to a Dashboard conversation, or when sending an image or file attachment there. Also covers the dashboard service itself - agent state, costs, tools, communication, scheduler and PM2 health (full features on Claude runtime; PM2, system health, communication and scheduler monitoring on all runtimes).
type: communication

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

# The CLI generates the actual route from config.json `port` (cli/lib/dashboard-install.js,
# applyDashboardRoute); this entry shows the default. The CLI is authoritative.
http_routes:
  - path: /dashboard/*
    type: reverse_proxy
    target: 127.0.0.1:3470
    strip_prefix: /dashboard

---

# Zylos Dashboard

Observability dashboard for a local Zylos agent, with a Dashboard conversation channel.

## Conversation channel

Before replying, consult [Available structured components](#available-structured-components)
for this Core's component list, selection guidance and complete examples.

Dashboard ships inside Core, so the Core it runs on always provides the
synchronous BeforeSend hook and post-storage stdin delivery this channel needs.
The channel declaration adds no separate service or registration step.

Send plain text through the C4 send entry, using the original conversation ID as
the endpoint. Core queries Dashboard for its local group name:

```bash
cat <<'EOF_MESSAGE' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js dashboard conversation_a
Your plain-text reply.
EOF_MESSAGE
```

Use the exact endpoint/group from the originating conversation; display names do
not select a destination. Do not call the low-level `c4-db.js insert` command for
Dashboard sends: it bypasses BeforeSend. Core stores the original text, then
passes the six-field delivery packet to `scripts/send.js` on stdin; the script's
argv does not carry the message body. Callers do not construct this packet.

The send check (BeforeSend) accepts plain text up to 65,536 UTF-8 bytes. Content
that starts with `[C4-JSON]` plus a newline must be a valid C4 envelope; malformed
envelopes and oversized messages are rejected before storage, so fix and send
again. A successful send confirms the stored row and channel handoff, not that a
person read it. If a send reports that the message is already stored, do not
resend it. Delivery, question registration and recovery details:
[docs/conversation-channel.md](docs/conversation-channel.md#delivery-and-question-registration).

### Which session group a conversation belongs to

Each Dashboard conversation is its own session group. Its local ID (the endpoint
in the reply-via route) is also its local group name; Core combines it with
Dashboard's namespace into `<namespace>:<local id>`. Core asks the channel for the
group name with `scripts/session-group.js`:

```bash
node ~/zylos/.claude/skills/dashboard/scripts/session-group.js conversation_a
# prints: conversation_a
```

It prints the endpoint unchanged after checking that it is a valid group name
(exit 0), and exits 1 with a message for an invalid name or `origin`. It does not
query any database, so it also returns a group name for a conversation that was
never created. This is a deliberate trade-off: the mapping stays a pure function
of the endpoint, and Core creates the group when it stores the first message for
it.

### Automatic conversation naming

The new-conversation button creates an unnamed draft immediately. On the first
Agent reply, an unnamed Dashboard conversation receives one control instruction
in its own group, with a five-minute acknowledgement deadline. This instruction
stays outside conversation history. Follow it by choosing a contextual name of
at most 20 characters in the conversation's language, then run:

```bash
node ~/zylos/.claude/skills/dashboard/scripts/conversation-name.js '<session-group>' '<name>' --json
```

The command uses the existing 1–40 character rename validation and writes only
while the name is empty. `NAME_WRITTEN` exits 0; `NAME_ALREADY_SET` exits 2 and
preserves the existing name; invalid input or an unavailable conversation exits
1. If naming is impossible, write `unknown` with the same command. Finish without
replying in the conversation. Dashboard also writes `unknown` for failed or
expired naming controls while the name remains empty. Later replies never repeat
the first-reply naming decision. Name changes update open lists and details.

### Available structured components

Choose a supported component when it makes the reply clearer or lets the user
answer directly. Keep ordinary replies concise. Selection guidance lives in the
component catalog and is returned by `list` and `describe`; consult it before composing.

Read the component list from the same installed Core before composing a C4 message:

```sh
node ~/zylos/.claude/skills/dashboard/scripts/components.js list --json
node ~/zylos/.claude/skills/dashboard/scripts/components.js describe choice@1 --json
node ~/zylos/.claude/skills/dashboard/scripts/components.js example choice@1
node ~/zylos/.claude/skills/dashboard/scripts/components.js validate message.txt
```

`list` reports only catalog entries implemented by this Core. `describe` returns
its parameters (including transitive definitions in `parameters.$defs`) and generated model instructions; `example` prints a complete
`[C4-JSON]` message suitable for stdin to the original reply-via command. Keep
that command's routing and absorbed-reply form unchanged. `example --json`
returns `{ok:true,data:<message>}` for inspection; send the raw example, not this
wrapper. No command sends a message or contacts another instance. This static
list describes the installed Core, not the version of a remote fleet browser.
Unimplemented or unknown component keys fail instead of offering examples.

Before sending, you can check a message with `components.js validate <file>`
(or pipe it on stdin): it runs the same send-time validator as the Dashboard
send check, exits 0 for valid content, and otherwise exits 1 with the first
error as `<path> [<code>] <message>`, where path is a JSON Pointer such as
`/blocks/0/data/action/type`. With `--json` it prints `{ok:true,data:{valid:true}}`
or `{ok:false,error:{code,path,message}}`. Fix that location and validate again.
Attachment IDs and reply routing are checked only when sending.

Write each envelope and block `fallbackText` as the real message in plain
words; channels without a renderer show only that text. A stored C4 message is
never updated in place: a block sent with `status: "pending"` stays pending, so
send the complete block in a later message. Omit `action.expiresAt`; the host
neither displays nor enforces it, and a late answer to an open question is
still accepted.

#### Arranging blocks with `metadata.view`

A message may add `metadata.view` to arrange its own blocks, for example two
charts side by side under a short summary. View only places blocks that the
message already contains; it adds no text, styling, links or actions. Node
types are `stack` (`children`, optional `gap`), `columns` (`children`;
`layout: "balanced"` takes 2–4 children, `"sidebar"` exactly 2), `section`
(`header`/`body`/`actions` ID arrays) and `block` (`blockId` of one complete
block in the same message). Every node must be reachable from `root`, each
block may be placed at most once, and blocks you leave out are shown after the
layout in their original order. Use View only on `kind: "message"`. Dashboard
rejects an invalid View before sending, so fix the layout rather than resending
unchanged; the full rules are in the C4 content protocol's "Host View" section.

```text
[C4-JSON]
{"version":1,"kind":"message","messageId":"pr_status_overview","fallbackText":"本周 PR 概况：共 5 个，已合并 3 个、待评审 2 个；仓库 core 3 个、docs 2 个。","blocks":[{"id":"summary","type":"markdown","schemaVersion":1,"data":{"text":"本周共 **5 个 PR**，已合并 3 个，待评审 2 个。"}},{"id":"by_status","type":"breakdown","schemaVersion":1,"data":{"title":"按状态","parts":[{"key":"merged","label":"已合并","value":3},{"key":"in_review","label":"待评审","value":2}]},"fallbackText":"按状态：已合并 3，待评审 2"},{"id":"by_repo","type":"category_series","schemaVersion":1,"data":{"title":"按仓库","points":[{"key":"core","label":"core","value":3},{"key":"docs","label":"docs","value":2}]},"fallbackText":"按仓库：core 3，docs 2"}],"metadata":{"view":{"schemaVersion":1,"root":"page","nodes":[{"id":"page","type":"stack","children":["intro","charts"]},{"id":"intro","type":"block","blockId":"summary"},{"id":"charts","type":"columns","layout":"balanced","children":["status_chart","repo_chart"]},{"id":"status_chart","type":"block","blockId":"by_status"},{"id":"repo_chart","type":"block","blockId":"by_repo"}]}}}
```

### Sending and reading attachments

On the target instance, prepare a private copy before sending an image or file:

```bash
node <skills-dir>/dashboard/scripts/attachments.js register --conversation <local-id> --kind file --path /absolute/path/to/report.pdf
node <skills-dir>/dashboard/scripts/attachments.js resolve --conversation <local-id> --id <attachment-id>
```

Take the local conversation ID from the current Dashboard reply route. `register`
accepts only ordinary readable files under the resolved instance's
`components/dashboard/media`, `workspace`, or `/tmp`. `--kind image` requires
PNG, JPEG, GIF or WebP magic bytes. The private copy survives moving or deleting
the source. Both services and this command read `WEB_CONSOLE_MAX_UPLOAD_MB` from
the actual instance's `.env`; invalid or missing values use 20 MiB. Each file is
limited independently, with at most 20 attachments per message.

Registration succeeds with
`{ok:true,attachmentId,name,kind,expiresAt}`. The expiry is the strict 25-minute
deadline for sending an unlinked attachment, not its deletion time. `resolve`
returns `{ok:true,path}` for a readable copy in the same conversation, including
a prepared but not yet linked copy. Failures exit nonzero and return
`{ok:false,error:{code,message}}` without a usable ID or another group's details.
The browser cannot download a prepared attachment until a real message links it.
Linked copies remain readable after login expiry, runtime expiry or 30 minutes.

Image/file blocks require a Core schema and Dashboard BeforeSend validator
that support `x-zylos.image` and `x-zylos.file`. Registration and resolution do
not add that protocol support. A Core without it rejects the whole envelope,
including when reading existing history; do not send these blocks until the
compatible schema and validator are deployed on all readers.

Use the returned ID and filename in the original message envelope:

```json
{"id":"report","type":"x-zylos.file","schemaVersion":1,"data":{"attachmentId":"<returned-id>","nameSnapshot":"report.pdf"},"fallbackText":"File: report.pdf (attachment <returned-id>)"}
```

For images use `x-zylos.image` and a registered `image` ID. Attachment blocks must
always include `data` and cannot have `pending` or `error` status. If registration
fails, explain the failure in plain text instead of sending an attachment block.
The block contains no source path, URL, bytes, size or MIME claims. Send the
complete envelope through
the **original reply-via command unchanged**, with content on stdin; preserve
its absorbed-reply form. Core queries the component to determine the group.
There is no attachment send subcommand. Plain `[MEDIA:...]` text does not
register or copy a file. Registration alone does not send a message; follow the
original send-result contract before deciding whether to retry. A failed send
does not consume the ID, and an already linked same-conversation ID can be
reused after its preparation deadline. BeforeSend accepts only agent registrations
until their first real message association; unlinked user uploads cannot be
referenced by an agent block. A wrong kind, expired or unreadable copy is rejected
with a target-instance registration hint. The hook never copies files or changes
the message. A failed association after C4 storage is repaired by history/GC;
do not resend an already stored message to repair it. Keep the filename and ID
in the envelope fallback as well as the block fallback. The component CLI only
advertises shipped renderers, so Schema support alone does not add an image/file
renderer to that list.

## Dashboard service

```bash
npm start
```

Default URL: `http://127.0.0.1:3470/`

A new installation generates an independent random Dashboard password. At the end
of non-quiet `zylos init`, the terminal shows the Dashboard address and new password once;
only its scrypt hash is saved. An existing config without a password is repaired
without changing its other settings. Existing passwords are retained and cannot
be displayed again. Quiet mode (including Docker startup) never prints the
Dashboard password; it tells you to run `zylos dashboard reset-password` on the
host or inside the container. Dashboard does not share Web Console credentials.
An older installation that becomes locked because it has no configured password
can recover with the same `zylos dashboard reset-password` command.

With Caddy, init shows the public `/dashboard/` route. With `--no-caddy`, it shows
`http://127.0.0.1:<port>/`; this is local-only port access without a public route.

To generate a replacement password, run:

```bash
zylos dashboard reset-password
```

The command shows the new password once and stores only its hash. Reset enables
Dashboard authentication even if it was explicitly disabled, so this recovery
command always restores a protected login. It clears all existing browser and
API sessions, including remembered logins; users must sign in again. API keys
remain configured. It restarts a
running Dashboard so the replacement applies immediately; if Dashboard is not
running, the change applies at its next start. If service status or restart cannot
be confirmed, restart Dashboard first, then run `zylos dashboard reset-password`
again to clear sessions the old process may have issued. Keep the displayed
password out of files, shell history and logs.

For optional terminal viewing, supported platforms and cleanup recovery, see
[Observer](docs/observer.md). Observer automatically selects the target Dashboard
host's platform: macOS Apple Silicon, Linux x64 or Linux ARM64. Install and enable
it from Settings; the linked guide lists host requirements and cleanup behavior.

### Settings

The service reads `~/zylos/components/dashboard/config.json`. Nothing is
collected at install time; edit the file by hand and restart Dashboard
(`pm2 restart zylos-dashboard`) to change:

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `3470` | Listening port. The CLI (`zylos init`, and the first upgrade that takes over Dashboard) writes the `/dashboard/*` Caddy route from this value, so the `http_routes` entry above only shows the default; after changing the port, run `zylos init` to rewrite the route. |
| `host` | `127.0.0.1` | Bind address. |

Do not edit the password in `config.json` by hand: `config.json` keeps only its
hash. Use `zylos dashboard reset-password` (see above).

## HTTP API

Draft, send, question and answer routes, receipts and their reconciliation rules
are in [docs/conversation-channel.md](docs/conversation-channel.md).
