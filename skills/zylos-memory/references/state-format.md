# Working state format

State is scoped working memory, read on demand together with inbox and
uncommitted segments. In multi mode it lives under `session-groups/<G>/`; in
single mode it lives directly under memory. Do not fall back to another mode's
old files. Sync owns state; ordinary threads record new facts in inbox.

The first physical line is:

```text
<!-- zylos-state v1 | scope=telegram:example | synced_at=2026-10-19T05:30:02Z | coverage=42 | inbox_committed=20261019T053001123Z -->
```

Use the current full group as scope, or `*` for single. Include all four header
fields once. `synced_at` is an ISO8601 timestamp with zone; coverage is a
conversation ID or empty; inbox_committed is a comma-separated set of legal
segment IDs, or empty. It is a file recovery marker, not authoritative DB
progress. The document then contains `# Working State` and all four headings:

| Heading | Content |
| --- | --- |
| `## Headline` | Current focus and next step |
| `## In Progress` | Work underway with pointers to detail |
| `## Pending` | Unresolved tasks, dependencies, blockers, and absorbed-message entries |
| `## Commitments` | Promises still requiring action |

Sections may be empty. There is no file length limit. Move completed narratives
out of state and deduplicate facts, but never drop unresolved work to meet a
size target. Detailed records belong in shared topic files via Origin/global
Sync; group Sync carries that learning in its checkpoint summary.

A conversion may put a `切换来信` block at the beginning of Pending. Its entries
point to individual absorbed C4 messages. The model does not rewrite or copy
this block into temporary state. Give commit only IDs whose follow-up is
confirmed by actual progress; an outbound audit row alone is not delivery
proof. Commit preserves all other lines and the original title exactly.

Use the restricted tool for `state.md.<token>.tmp` after checkpoint succeeds,
then `sync-files.js commit` for formal replacement. A damaged header is a reader
fallback, not permission to discard the body or uncommitted segments. See
[the example](../examples/state.md).
