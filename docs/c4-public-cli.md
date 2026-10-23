# C4 database and query commands

The database CLI, checkpoint CLI and fetch CLI share strict argument parsing and
use the current C4 schema and store. Use an isolated `ZYLOS_DIR` for development.
These commands do not send messages to channels.

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
- `c4-db.js groups [--match TEXT] [--limit N] [--json]`
- `c4-db.js mode-transition show [--run-id UUID] [--json]`
- `c4-db.js origin-sync backlog [--json]`
- `c4-fetch.js --begin ID --end ID [--json]` preserves the requested historical range.
- `c4-fetch.js --checkpoints [--group GROUP] --after END [--json]`
- `c4-fetch.js --origin-sync --group GROUP --summaries-only [--json]`
- `c4-fetch.js --origin-sync --group GROUP --raw-only --after COVERAGE [--limit N] [--json]`
- `c4-fetch.js --origin-sync --group GROUP [--limit N] [--json]` reads both parts in one snapshot.
- `c4-fetch.js --absorbed --run-id UUID [--summary | --id ID --offset OFFSET | --after ID] [--max-bytes N] [--json]`

Absorbed queries retain the store's encoded byte budget and pagination markers.
Ordinary text fetches encode reply arguments while the original row is still
available. JSON success is `{ok:true,data:...}`; JSON failure is
`{ok:false,error:...}` with a nonzero exit code. Existing text commands retain
human-readable output. `--` ends option parsing for positional content.

This implementation does not supply the strict configuration reader or live
session resolver/adapter. Control enqueue and runtime/model configuration remain
pending that integration. Router, receive/send and session bootstrap cutovers are
separate work; these commands do not establish readiness to run an existing
instance, merge a release, or deploy.
