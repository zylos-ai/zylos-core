---
name: zylos-memory
description: >-
  Read and maintain Zylos memory. The supervisor runs nightly memory dreaming
  in an independent process. Use the scoped handoff to continue unfinished work.
---

# Memory System

The supervisor runs [memory dreaming](references/dreaming.md) independently of
live sessions. It reads delivered C4 conversations, updates shared project and
decision pages, and writes the dated diary. Rule proposals go to the owner for
approval. Live sessions keep working while this process runs.

## Continue unfinished work

Use the current scope's `handoff.md` and recent conversations. Read the handoff
completely before relying on it. For cross-group work, ask the owning thread
via the internal channel. Do not change another group's files.

During the first handoff after an upgrade, use `read-work-memory.js --json` to
read any historical state for the current scope. Merge unresolved items into
its handoff, save it atomically, verify the contents, and then archive the old
state. The system instructions describe the scope-specific paths. Existing
session logs remain accessible and historical inboxes are under
`memory/archive/inbox/`.

## Shared memory

Consult the [project format](references/projects-format.md),
[decision format](references/decisions-format.md), and
[reference index format](references/references-file-format.md) for durable
knowledge. Search current and archived pages before creating a duplicate. For
older subjects missing from those indexes, search `memory/reference/legacy/`
for relevant headings or keywords and read only the matching sections. The
one-time [reference reorganization](references/reference-reorg.md) archives the
original aggregate files.

Fulfill an explicitly authorized edit to shared self knowledge in the running
session. After an actual identity change, run `request-rotation.js --reason
identity` and report any rejection. Component callers use the
[locked memory writer](references/memory-write.md).
