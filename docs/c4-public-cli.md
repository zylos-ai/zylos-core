# C4 database and query commands

The database CLI, checkpoint CLI and fetch CLI share strict argument parsing and
use the current C4 schema and store. Use an isolated `ZYLOS_DIR` for development.
These commands do not send messages to channels.

## External sends and session handoffs

`c4-send.js <channel> [endpoint] --stdin` asks the installed component's
`scripts/session-group.js <endpoint>` for the group before BeforeSend or writing
an outbound row. The query uses Node argv, closed stdin, the component directory
as cwd, and the send environment. It has a five-second timeout and a 4 KiB stdout
limit. One final LF or CRLF is removed; empty output, no script or a NULL endpoint
means the whole component namespace. Nonempty output must be a valid group name
of at most 95 characters. Failed, timed-out, oversized or invalid queries refuse
with `SESSION_GROUP_QUERY_FAILED`; they do not fall back or send anything.
`dashboard origin` has fixed group `origin` for both inbound and outbound and
does not query the component.

Core compares that one result with inherited `ZYLOS_SESSION_GROUP` when the key
exists. Empty or unknown senders fail `UNKNOWN_GROUP`; `origin` is a normal
sender. If the key is absent, Core still queries and records under the answer
but skips the comparison. Cross-session sends fail `CROSS_SESSION_OUTBOUND`:
no message, hook or delivery occurs, even when the target group has no history.
A missing namespace binding may be allocated so the error can name the complete
group; refusal does not create message rows. The error supplies a shell-quoted
internal command with placeholders rather than echoing the endpoint:

```sh
cat <<'EOF_INTERNAL' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js internal 'telegram:recipient-session'
Please deliver to <channel> <address>: <text>. Why: <reason>.
EOF_INTERNAL
```

Use the target and installed script path supplied by the error. Do not override
the sender environment. Internal success means queued, not read or delivered
externally. The responsible session makes the external send. No waiting-sender
registry, automatic reply copies or return-reply instruction is added.

Same-group replies pass. Message history and target-head existence never choose
ownership. The query is not cached, and the group is neither queried nor checked
again in the write transaction. A trailing legacy `--session-group NAME` is
silently accepted and ignored; malformed placement remains `INVALID_ARGS`.
Generated reply-via commands do not contain it. System notification callers clear
both session variables before spawning C4. The guard also covers absorbed replies:
relay the text and exact `--absorbed-reply R N` command to the responsible group,
without reconstructing its private endpoint. Internal handoffs can create a new
target group if its namespace belongs to an installed component.
OpenMax's direct `comm.send` / `comm.ask` platform calls bypass C4 and are outside
this check. Scheduler's query/persistence integration is delivered separately.

## Database and query examples

```sh
node skills/comm-bridge/scripts/c4-db.js insert out system null 'diagnostic note'
node skills/comm-bridge/scripts/c4-db.js unsummarized --json
node skills/comm-bridge/scripts/c4-fetch.js --unsummarized --limit 100 --json
node skills/comm-bridge/scripts/c4-checkpoint.js create 1 --summary 'Summary'
node skills/comm-bridge/scripts/c4-checkpoint.js latest --json
```

Without `--group`, checkpoint and Sync queries use the global `*` scope.
Checkpoint writes require exactly one of `--summary TEXT` or `--no-content`.
A no-content checkpoint advances coverage without replacing the latest content
summary. Group queries reject `--group '*'`; omit that option for global reads.
Pending input bounds the safe read frontier. Limited reads report `upTo` as the
last included row when more data remains, and `safeEnd` as the safe frontier.

Other independent commands:

- `c4-control.js expire --id ID` expires only a pending/running control.
- `c4-db.js namespace get|ensure COMPONENT`; `namespace register COMPONENT NAMESPACE`
- `c4-db.js session-group COMPONENT [--session-group LOCAL_GROUP]`
- `c4-db.js groups [--match TEXT | --active-since MS | --key-match TEXT] [--limit N] [--raw] [--json]`
- `c4-db.js group-queues [--json]`
- `c4-db.js mode-transition show [--run-id UUID] [--json]`
- `c4-db.js origin-sync backlog [--json]`
- `c4-fetch.js --begin ID --end ID [--json]` preserves the requested historical range.
- `c4-fetch.js --checkpoints [--group GROUP] --after END [--json]`
- `c4-fetch.js --origin-sync --group GROUP --summaries-only [--json]`
- `c4-fetch.js --origin-sync --group GROUP --raw-only --after COVERAGE [--limit N] [--json]`
- `c4-fetch.js --origin-sync --group GROUP [--limit N] [--json]` reads both parts in one snapshot.
- `c4-fetch.js --absorbed --run-id UUID [--summary [--scope-after GROUP] | --id ID [--field text|endpoint] [--out FILE] | --after ID] [--limit N] [--json]`

`groups` filters are mutually exclusive. `--match` also searches message previews.
`--key-match` matches group keys only (any part, any letter case) and is meant for occasional
searches. A group whose key equals the search text exactly (same letter case) comes first,
then the others newest first.
`--active-since` takes Unix milliseconds, stops at the first older group, and returns
`{groups, hasOlder}`; the other forms return an array.
Each group's `preview` (the newest inbound message, or `null`) is
`{timestamp, channel, endpoint, text, message, messageSource?, messageRaw?}` (`messageRaw` only with `--raw`): `text` is the model-facing
projection of the whole message, and `message` is a one-line reader preview, at most 80
characters, without the appended reply route, or `null` when the message carries only
channel wrapping or is an overflow pointer to a stored file. `message` is, in this order:

- for a C4 envelope, its `fallbackText`. A component that wants a summary of its own in
  previews sends an envelope; `fallbackText` is required, 1 to 16000 characters, and
  previews show its first 80 characters with whitespace collapsed;
- for a channel message, the `<current-message>` body without its sender prefix;
- for a task dispatched by core's scheduler, the first line of the task prompt, with
  `messageSource: {kind: "scheduled_task", taskId}` so a reader can look up the task name;
- for any other message that starts with bracketed tags (a source core does not know), its
  first line without those tags, with `messageSource: {kind: "header"}`; a reader labels it
  with the channel. This does not apply on channels `dashboard` and `web-console`, core's own
  channels that store what a person typed as is: there a leading `[…]` (including a Markdown
  link `[text](url)`) is the person's words and stays;
- otherwise the message itself.

Previews from the scheduler or another source's header also drop long identifiers (UUIDs,
`task-…` ids containing a digit, runs of 16 or more hex digits), together with an id's own
label (`id: …`, `Task ID: …`, `id=…`) and a `(by …)`-style group the id leaves empty.
`messageSource` is absent for a person's own words and envelopes.

`--raw` (off by default, so list and polling output stay small) adds `messageRaw` to each
preview that has a `messageSource`: the stored message's start for a technical view, the
model-facing projection with line breaks kept, at most 2000 characters. A longer message is
cut before a run of printable ASCII characters rather than inside it (where a credential or
a link would be), other text is kept up to the limit, and it ends in `…`. To read one
group's, use `--key-match KEY --limit 1 --raw` and check that the row's `sessionGroup` equals
`KEY` (when no group has that exact key, the row is another group containing it). C4 does not redact
`messageRaw` (nor `text` or `message`); a reader that shows it redacts credentials first.

`group-queues` is a read-only snapshot of the groups that have pending or running
inbound messages or a drain fence. It returns `{groups, globalFence}`, and each group has
`{sessionGroup, pending: {count, oldestAt, head}, running: {count}, fence}`. A group
missing from a successful result has nothing pending, nothing running and no fence. If
the command fails, treat every group's queue as unknown, not as empty. `globalFence` is
the `*` fence or `null`.

Absorbed queries paginate by count: pages default to 20 records (maximum 100),
and summaries default to 50 scopes (maximum 200). Pages preview the first 300
Unicode code points of each message; `--id` returns the complete selected field.
`--out` writes that field to a new file and refuses to overwrite an existing file.
The retired `--offset` and `--max-bytes` options are rejected.
Ordinary text fetches encode reply arguments while the original row is still
available. JSON success is `{ok:true,data:...}`; JSON failure is
`{ok:false,error:...}` with a nonzero exit code. Existing text commands retain
human-readable output. `--` ends option parsing for positional content.

Control and configuration commands use the instance's strict configuration
reader and the Core package's runtime implementation. A copied skill locates its
Core package through `ZYLOS_PACKAGE_ROOT`, the source-tree location, the `zylos`
executable on `PATH`, or the global npm package location, in that order.
A broken explicit package root is an error.

- `c4-control.js enqueue --content TEXT [--group GROUP] --target-run RUN_ID [--expected-runtime RUNTIME] [--expected-session SESSION_ID] [--json]`
- `c4-runtime-config.js get|set|reset --group GROUP [--runtime RUNTIME] [--json]`
- `c4-model-config.js get|set|reset --group GROUP --runtime RUNTIME [--model MODEL --effort EFFORT] [--json]`

Runtime/model selectors also accept `--channel COMPONENT [--session-group NAME]`
instead of `--group`. Targeted controls with acknowledgement require
`--ack-deadline SECONDS`; `--no-ack-suffix` omits acknowledgement. Single mode
uses no group selector for controls. Expected runtime/session flags require
`--target-run`. Enqueue success proves the database commit, not delivery. With `--json`, enqueue
returns one line containing `{ok:true,data:{id,supersededCount}}`; targeted
success also includes the committed `targetBinding` object. Refusals return
`{ok:false,error:{code,message,persisted,...}}` on stdout with a nonzero exit,
including the observed `runId` for a target mismatch. Without `--json`, the
existing text output is retained.

Target binding and running-state observation return Promises. Callers await
observation and revalidation of the original tmux object over one connection,
outside database transactions. The connection's own timeout applies. No
snapshot is assembled from separate connections. Running configuration status
also checks actual process identity; launch metadata alone is insufficient.
Model overrides query the real runtime executable's help and validate the pair
before writing. This verifies the local adapter's argument contract, not that a
remote model is available to the account.
