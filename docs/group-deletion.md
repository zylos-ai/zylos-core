# Delete a conversation

The Dashboard conversation list, `zylos group delete`, and the deletion API use
one Core coordinator. Deletion is irreversible. It removes completed messages
through the confirmed preview cutoff and data proven to belong to those messages.
Later messages, pending/running input and data with uncertain ownership remain.
Main memory, backups, scheduled tasks and usage/cost records remain. Deleted
messages no longer contribute to message totals.

Origin cannot be deleted. The Dashboard requires a local administrator signed
in with the instance password; API keys and Fleet remote views cannot preview
or execute deletion. DELETE must be same-origin. Active Core group deletion
requires multi-session mode. A true Dashboard draft uses storage-only cleanup.

## Preview and confirmation

Preview returns an `operationId`, `cutoffId`, `generationId` and `targetKey`.
Core reads the group's maximum message ID and last completed deletion identity
in one snapshot. `generationId: null` means the first generation, not any
generation. `targetKey` binds the exact group, or draft namespace and local ID.
The message count includes pending/running messages through the cutoff because
those messages may complete before confirmation. Messages still pending/running
at final cleanup remain, so the actual deletion count can be lower.
Preview creates no audit or lock. A preview of an active deletion instead
returns that operation's stored boundary.

Deletion is an administrator-only interface, including the local CLI. Confirmation
must carry the same fields. Both the coordinator before admission and the Core
writer reject a cutoff above the group's current maximum message ID. Preview is
stateless: a caller-supplied in-range cutoff cannot be distinguished from a real
preview value. This boundary is not a substitute for administrator authorization.
Core checks the generation again in its admission writer transaction and stores the boundary in the existing audit.
Only terminal messages with `id <= cutoffId` are eligible. Message IDs use the
existing AUTOINCREMENT allocator. If another deletion has completed since the
preview, a different preview operation is stale, even if new messages have
recreated the same group. Core refuses it with `DELETION_PREVIEW_STALE`; preview
and confirm again. A draft promoted to an active group also needs a new preview.

The same operation can be retried without widening its recorded cutoff. A
completed retry returns the original audit result before resolving or deleting
a recreated target. A different operation cannot take over an active deletion.
The Dashboard retains the confirmed fields across pending results and lost
responses. A stale confirmation clears them and displays an instruction to
preview and confirm again.

## Command line

```sh
zylos group delete telegram:room --json
zylos group delete telegram:room --yes --json
zylos group delete telegram:room --yes --json --operation-id <started-operation-id>
```

Without `--yes`, the command only previews. Its human-readable output includes
the exact confirmation flags. To confirm a previous preview, carry its values:

```sh
zylos group delete telegram:room --yes --json \
  --operation-id <preview-operation-id> --cutoff-id 123 \
  --generation-id 'null' --target-key '["group","telegram:room"]'
```

`--generation-id` is JSON: use `null` for the first generation or a quoted JSON
string for a prior completed operation. A fresh `--yes` without any operation or
boundary flags explicitly previews the current target within that invocation
before confirmation. An unknown operation ID without its full preview boundary
is refused; it never silently takes a newer preview. A known audit retry can
supply only its operation ID. `--actor` supplies the audit actor (default local
CLI user). The CLI does not present an interactive prompt.

## Waiting and unknown results

Admission, waiting for the stopped run and final transcript import share one
20-second cooperative budget measured from coordinator entry. Admission has a
maximum of 10 seconds within the remaining budget, with at least one second to
connect and submit even after expensive preview work consumes that budget. This
floor can exceed 20 seconds; drain and import receive no renewed waiting budget.
Import checks its entry, each discovered subagent, Codex batch boundaries and
each mapping's end. If work remains, retry the same operation.

This is not a hard process limit. Claude's synchronous unread-tail read, Codex's
initial metadata scan and final SQLite/file operations cannot be interrupted.
Very large files or stalled storage may exceed 20 seconds and even the Dashboard
child's 30-second timeout. The user may receive a generic error instead of
pending. An unavailable or unparseable child response is an unknown result,
never fabricated success. Keep the operation ID and confirmed boundary: an
unfinished audit resumes; a completed audit returns its original result.

## Dashboard API

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/workbench/groups/:group/deletion` | Preview and confirmed boundary |
| DELETE | `/api/workbench/groups/:group` | Delete through the preview cutoff |
| GET | `/api/chat/drafts/:localId/deletion` | Preview the draft or its bound group |
| DELETE | `/api/chat/drafts/:localId` | Delete that exact preview target |

Encode groups as URL path components. DELETE accepts only the server preview's
fields plus explicit confirmation:

```json
{"confirmed":true,"operationId":"<preview-id>","cutoffId":123,"generationId":null,"targetKey":"[\"group\",\"telegram:room\"]"}
```

The actor comes from the authenticated cookie. Successful completion returns
`ok: true`, `pending: false`, `operationId`, `counts`, `countsEstimated`,
`retainedMessages` and `groupDataRetained`. The retained count is the number of
messages remaining when the final Core transaction completes, including later
messages and input still pending/running. Group-wide data is retained whenever
that count is positive. The audit stores this count, so a completed-operation
retry returns the original result even after the conversation receives more
messages. True drafts and groups with no remaining messages return `0` and
`false`. CLI output and the Dashboard's localized completion notice explain
that messages and conversation memory remain only when the count is positive.
HTTP 202 with `pending: true` is unfinished: `draining` waits for current work,
`usage_pending` waits for final import. Retry retains the same confirmation.
A stale preview or ownership conflict returns 409. Errors preserve participant
HTTP status through Core CLI JSON (for example missing conversation 404 or
unavailable Dashboard storage 503). Single-session group admission returns
`not_multi`; true drafts do not need a runtime stop.

Bare namespace groups such as `telegram` can be deleted: fallback replies routed
to that group belong to it. Origin remains protected.

## What is deleted and what is conservatively retained

Every Core message delete and overflow-file target is bounded by the audited
cutoff. Pending/running inbound messages always remain, including those older
than the cutoff. Core recomputes the remaining head and releases its delete
fence only after cleanup and audit settlement.

Dashboard registration deletion matches the exact namespace and local ID.
True drafts have an explicit draft/NULL-namespace condition. Attachment lookup
uses the resolved namespace; an unavailable namespace refuses deletion instead
of falling back to local ID alone. Attachments are removed only when every
message association proves that it belongs to the target's deletable messages,
with no retained or foreign message reference. Unlinked uploads and unknown
associations remain, including uploads attached to a true draft; deleting a
draft removes its registration but retains those files. No age or watermark
heuristic substitutes for ownership proof.

Questions and answers require proven eligible question and delivery-message
associations; uncertain or retained associations remain. If any group messages
remain, deletion keeps group-wide memory, runtime originals and their import
cursors/mappings, runtime events, registration, display names, overrides,
checkpoints, controls and ending/slot state whose ownership cannot be split at
the cutoff. Final transcript import can be skipped when no raw file is eligible
for removal. This may retain old content along with newer content; safety takes
priority over complete removal. Deleting again after a fresh preview may remove
more once the ownership boundary is clear.

When no group messages remain, mapped runtime originals are removed only after
final usage import proves stable EOF. Usage mappings and metric points remain.
Only mapped sources and their confirmed session directories are eligible;
expired/unmapped transcripts are not found through an account-wide scan.
Shared Claude history stays intact because unrelated writers may append or
retain its old file descriptor. If another group (including unknown ownership)
uses the same session ID, session-env and shard-spill directories keyed solely
by that ID stay intact. Group-specific transcript paths still require the usual
path and symlink checks.

## Lifecycle, ownership and counts

Core creates one audit and an owned delete fence. New input claims wait while
running messages, controls and subagents finish. The runtime stops without
automatic restart. A configuration-reclaim control can acknowledge readiness
under the same run's delete fence; it neither replaces that fence nor schedules
a restart. Retained input can subsequently run normally. Dashboard recreation
is registered only on authorized send/attachment writes after Core namespace
and history proof; reading, attachment configuration and rename do not create
a registration. An unregistered group rename returns 404.

Core owns C4 writes; Dashboard owns its own database and media. Cleanup takes
Core's writer before Dashboard's writer and removes files before references.
A crash may leave missing files with retained rows. Retry tolerates absence and
uses the same audit; it cannot expand its cutoff. A busy Dashboard writer may
also make other groups' inbound C4 writes encounter a busy failure while the
Core writer waits. There is no deletion job table or saved file manifest; the
cutoff, target and generation are stored in the existing audit.

Normal first completion reports actual observed removals, never preview totals.
A durable cleanup attempt is recorded before irreversible file work. Known
pre-file failures retract their attempt after rollback. File-phase failure or
process death retains uncertainty; final writer settlement derives
`countsEstimated` from the current attempt count. Interrupted retry counts cover
observable removals on that retry, not reconstructed original totals. A process
killed between durable marking and the first file operation conservatively
reports estimates. This audit metadata does not control admission or scheduling.
