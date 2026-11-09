# Delete a conversation

The Dashboard conversation list, `zylos group delete`, and the deletion API use
the same Core coordinator. Deletion is irreversible. It removes the selected
conversation's messages, attachments, group memory, activity records and mapped
local runtime transcripts. Main memory, backups, scheduled tasks and usage/cost
records remain. Deleted messages no longer contribute to message totals.

Origin cannot be deleted. The Dashboard only permits a local administrator
signed in with the instance password. API keys, including administrator keys,
and Fleet remote views cannot preview or execute deletion. DELETE requests must
be same-origin. Deleting an active Core group requires multi-session mode;
single-session admission returns `not_multi` through the CLI or API. A true
Dashboard draft with no bound Core group uses storage-only cleanup and does not
require multi-session mode.

## Command line

```sh
zylos group delete telegram:room
zylos group delete telegram:room --yes --json
zylos group delete telegram:room --yes --json --operation-id <operation-id>
```

Without `--yes`, the command prints a preview and returns without changing
anything. `--yes` confirms deletion. `--actor` can supply an audit actor; the
default is the local CLI user. A pending result includes an `operationId` to
retain when retrying. The CLI does not present an interactive prompt. It waits
within one 20-second budget measured from coordinator entry. Admission
(its own maximum is 10 seconds), the stopped-run wait and final transcript
import share that budget; transcript import checks it between mappings and
Codex batches. If work remains, retry the same command with that operation ID.

This is a cooperative budget, not a hard process time limit. A single
synchronous call cannot be interrupted: Claude reads its unread transcript
tail, Codex initially scans transcript metadata, and final SQLite/file
operations run synchronously. Very large files or stalled storage can therefore
exceed 20 seconds and even the Dashboard child's 30-second timeout. The Dashboard
then reports a generic error rather than a pending result. Retry remains safe:
keep the operation ID; an unfinished audit resumes, and a completed audit
returns its original result without deleting a recreated conversation.
Interrupted file cleanup is reflected in estimated counts.

## Dashboard API

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/workbench/groups/:group/deletion` | Preview and operation ID |
| DELETE | `/api/workbench/groups/:group` | Delete the encoded session group |
| GET | `/api/chat/drafts/:localId/deletion` | Preview a draft or its bound group |
| DELETE | `/api/chat/drafts/:localId` | Delete that draft or its bound group |

Encode the group as a URL path component. DELETE accepts only:

```json
{"confirmed":true,"operationId":"<preview-operation-id>"}
```

The server derives the audit actor from the authenticated cookie. A preview
contains `messages`, `attachments`, `files`, `draft`, and `operationId`. A
successful execution returns `ok: true`, `pending: false`, `operationId`,
`counts`, and `countsEstimated`. HTTP 202 with `pending: true` means the operation remains fenced and
can be retried: `draining` waits for current work to finish, while `usage_pending`
waits for final transcript import. It does not mean deletion has completed.
The Dashboard shows a visible instruction to click delete again to continue;
that retry keeps the same operation ID and does not ask for confirmation again.

Keep the same operation ID after a timeout or lost response. A completed
operation acknowledges its original result and cannot delete a newly recreated
conversation. Concurrent retries for the same group reuse its active operation.
Errors carry an `error.code`; permission errors are rejected before Core
mutation, and an active mode transition returns a conflict. An unavailable or
unparseable child-process response is an unknown result, never a success.
Participant errors retain their HTTP status across the Core child response
(for example missing conversation 404 or unavailable Dashboard storage 503).
The CLI JSON error includes that status; active Core group admission in
single-session mode returns `not_multi` rather than starting deletion. True
Dashboard drafts use the lightweight storage-only path described above.

Normal first-attempt completion records actual removals, even if pending input
causes an attachment from the preview to be retained. If cleanup was interrupted
after entering its file phase, a completed retry sets `countsEstimated: true`.
Those counts describe removals observed during the retry; earlier removed files
may no longer be countable. Preview counts never fill in actual removal counts.
The CLI and Dashboard result label such counts as estimates. This audit-only
flag does not decide admission, retries, scheduling or fence release.
The same audit row counts cleanup attempts. Finalization rechecks that count
inside its Core writer transaction, so a caller paused before cleanup cannot
overwrite uncertainty after another caller removed files and rolled back Core.
All final self-checks precede a process-local file-phase callback. A caught
failure before that callback retracts this attempt after rollback, so a busy
Dashboard writer that removed nothing does not make a later retry estimated.
If the process is killed between the durable attempt marker and the file phase,
the retry conservatively reports estimates: after a crash there is no proof
that no file was removed in that interval. This changes no lock order or
persistent control state. A concurrent caller that finishes before a failed
attempt's retraction also conservatively retains the estimate; it has not yet
observed proof that the other attempt stopped before files.

## Lifecycle and retained input

Core admission creates a delete fence and one audit row. The fence prevents new
input claims. Running messages and controls finish, the runtime becomes idle,
active subagents finish, and the runtime stops without automatic restart.
If a configuration-reclaim control is already running, its same-run readiness
response is acknowledged under the existing delete fence. The control can
finish; this response neither replaces the fence nor schedules a restart. A
confirmed run ending precedes final import of the group's mapped transcripts to
EOF. Import failures retain the fence and raw files for a retry; the ordinary
collector's finished policy is unchanged.

Deletion removes all outbound messages and terminal inbound messages. All
pending inbound messages remain, including input queued before the fence.
Terminal controls and controls bound to the old run are removed; unbound pending
controls remain. Core rebuilds the group head from retained input and releases
the fence after cleanup and the audit update. Retained or later input can then
create a fresh session with the default model/runtime configuration. Dashboard
registration is recovered only for a group whose Core history and namespace
prove it belongs to Dashboard, and only after authorization on send or
attachment-write paths. Reading, attachment configuration and rename do not
create a registration.

Core owns C4 writes. The Dashboard storage participant owns its own database and
media files. Cleanup takes Core's writer before Dashboard's writer; files are
removed before their references. A crash may leave removed files with retained
references, so a retry recomputes the targets and continues the same audit.
While Core holds its C4 write lock, the participant takes the Dashboard write
transaction and removes files. If the Dashboard writer is busy, other groups'
inbound C4 writes may also encounter a busy failure while deletion waits.
There is no deletion job table, saved file manifest, or persisted message cutoff.

Only runtime files located through retained `usage_transcripts` mappings and
their confirmed session directories are eligible. Old transcripts whose mapping
has already expired are outside this first version's cleanup; deletion does not
scan the account's runtime directories to guess ownership. Usage mappings and
metric points remain subject to their existing retention policy. Mode-switch
history and other backups also retain their existing expiry rules.

The shared `~/.claude/history.jsonl` is retained. Other Claude conversations can
append to it or hold its previous file handle while deletion runs. Replacing
that shared file could lose their records. Deletion does not coordinate native
Claude writers or depend on a particular CLI version's private lock protocol;
this exception does not retain the target session's separately mapped
transcript or session directory.
