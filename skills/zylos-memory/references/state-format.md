# Working state format

State is scoped working memory, read on demand together with inbox and
uncommitted segments. In multi mode it lives under `session-groups/<G>/`; in
single mode it lives directly under memory. Do not fall back to another mode's
old files. Sync owns state; ordinary threads record new facts in inbox.

The first physical line is a state header.

Use the current full group as scope, or `*` for single. Include all four header
fields once. `synced_at` is an ISO8601 timestamp with zone; the commit script
sets it from its actual publication clock in UTC, including milliseconds.
The worker must preserve an existing valid timestamp from the state/skeleton
in temporary state instead of calculating a new time. If neither exists, use
the fixed placeholder `1970-01-01T00:00:00Z`. The temporary value is
format-checked, then always overwritten at publication; it is never trusted as
the commit time. This prevents local time mislabeled as UTC or a rounded future
time from advancing the next session-log selection boundary. Coverage is a
conversation ID or empty; inbox_committed is a comma-separated set of legal
segment IDs, or empty. It is a file recovery marker, not authoritative DB
progress. The commit script fills `inbox_committed` from this round's listed,
verified segments. When creating a missing state, leave it empty. A
script-prepared copy may retain the old value; commit always replaces it with
the verified current IDs. For example, with no notes this round, the published
header is:

```text
<!-- zylos-state v1 | scope=telegram:example | synced_at=2026-10-19T05:30:02.123Z | coverage=42 | inbox_committed= -->
```

For a newly created temporary state, use an empty marker regardless of this
round’s notes. A script-prepared copy may retain its old marker; commit always
replaces it during publication.

With one new note `20261019T053002123Z`, only that ID appears, even if the old
state named `20261019T053001123Z`:

```text
<!-- zylos-state v1 | scope=telegram:example | synced_at=2026-10-19T05:30:02.123Z | coverage=42 | inbox_committed=20261019T053002123Z -->
```

The document then contains `# Working State` and all four headings:

| Heading | Content |
| --- | --- |
| `## Headline` | Current focus and next step |
| `## In Progress` | Work underway with pointers to detail |
| `## Pending` | Unresolved tasks, dependencies, blockers, and absorbed-message entries |
| `## Commitments` | Promises still requiring action |

Sections may be empty. Target 20 KiB (20 * 1024 bytes), the soft budget defined
by STATE_BUDGET_BYTES in sync-files.js. Keep only current focus, genuinely pending
work and blockers. Before removing a completed or superseded item, put one
result line per item in this round's checkpoint summary. Group Sync leaves
project-page recording to Origin Sync and does not write shared references.
Single global Sync records results in project pages itself before checkpoint.
Never drop unresolved work or absorbed messages for size. Commit reports
`stateBytes`, `stateBudgetBytes`, and `stateOverBudget` for the published UTF-8
file, including its final header and preserved absorbed lines. Overflow does
not reject publication or trigger a retry.

A conversion may put a `[Mode-switch messages]` block at the beginning of
Pending. Existing state may still use the legacy `[切换来信]` title. Its entries
point to individual absorbed C4 messages. The model does not rewrite or copy
this block. A script-prepared temporary copy may contain it; leave it unchanged
and let commit preserve the official remaining lines. Give commit only IDs
whose follow-up is
confirmed by actual progress; an outbound audit row alone is not delivery
proof. Commit preserves all other lines and the original title exactly.

Read the entire existing state in bounded byte ranges before either mode.
Update changed statuses in their original entries, rather than appending
conflicting status notes. Remove completed/superseded entries this round and
preserve their results as described above.

After checkpoint succeeds, run `sync-files.js prepare --token T`. The script
measures actual state bytes and returns:

- `mode:"rewrite", bytes:N` above 20480 bytes: no copy is made. Create a complete
  compact `state.md.tmp` through `edit_memory`, targeting <=20 KiB. Keep current
  focus, pending work and blockers; omit the completed/superseded narratives and
  manually copied absorbed block. For rules, lessons and pitfalls already saved
  elsewhere, keep only a one-line pointer to their source file in state, not
  their full text. Commit restores the official remaining block.
- `mode:"edit", bytes:N` at or below budget: an exclusive byte-for-byte copy was
  made. Use restricted unique-fragment edits at `state.md.tmp` for changed text,
  including coverage, and leave any copied absorbed block untouched.
- `reason:"STATE_MISSING"`: create a complete initial four-section document with
  `edit_memory` and the fixed timestamp placeholder described above.

Do not choose a mode from an estimated size or overwrite an existing draft.
Use the existing header format, this scope and batch-end coverage, and retain
a valid old timestamp (or the fixed placeholder). Newly created rewrite drafts
leave inbox_committed empty; copied drafts can retain its old value. Commit
validates the header, stamps synced_at and fills inbox_committed in every mode.
The tool maps this fixed name to the current scope's temporary state file for
the acquired token. Then use `sync-files.js commit` for formal replacement.
A damaged header is a reader fallback, not permission to discard the body or
uncommitted segments. See
[the published-state example](../examples/state.md). Its `inbox_committed`
value is filled by the commit script. Leave it empty when creating a missing
state; a script-prepared copy may retain its old value until commit.
