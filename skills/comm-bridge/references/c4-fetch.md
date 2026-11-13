# c4-fetch.js — Fetch Conversations

Retrieves the last checkpoint summary and conversations within a specified id range or from a point in time. Used by Memory Sync to load conversation data for summarization.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin <id> --end <id>
~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --since <duration|datetime>
```

`--since` accepts:
- a relative duration in minutes, hours or days: `30m`, `6h`, `24h`, `1d`
- a datetime: `2026-06-04`, `2026-06-04 12:00`, `2026-06-04 12:00:00`, optionally with `T`, milliseconds and a `Z` or `±HH:MM` offset (`2026-06-04T20:00+08:00`, `2026-06-04T12:00:00.000Z`)

A datetime without an offset is UTC, like the conversation timestamps in the output. Conversations at or after that time are returned. `--since` cannot be combined with `--begin`/`--end` or another fetch mode such as `--unsummarized`. Like `--begin`/`--end`, it covers all session groups and shows the global last checkpoint summary. With `--json`, the result is `{checkpoint, since, rows}`.

## Text Projection

`--unsummarized [--group G] [--after ID] [--up-to ID] [--limit N] --out FILE`
creates a new private file (mode 0600), refusing to overwrite an existing path.
The file contains exactly the ordinary direct output, including when `--json`
is selected. Stdout contains only export metadata: the absolute `path` (the
script resolves a relative `FILE`), `count`, `firstId`, `lastId`, `bytes`,
`sha256`, and `batch` (inside the usual data envelope with `--json`). Read the entire file and verify its byte count and SHA-256 before
summarizing it. `sha256` hashes the file bytes; `batch.sha256` instead hashes
stable projected conversation fields and is the receipt used by checkpoint
verification. The receipt's `after` honors actual coverage and `--after`;
its `end` is the last returned row ID, or the query's upper bound for an empty
batch. A limit cannot authorize checkpointing unread rows. No receipt is stored
on the host. An export with a reversed receipt range is rejected.

Origin Sync exports its two reads the same way:
`--origin-sync --group G --summaries-only --out FILE` and
`--origin-sync --group G --raw-only --after C [--limit N] --out FILE`. The file
again equals the direct output byte for byte, and the metadata has the same
fields with `receipt` instead of `batch`; `count`, `firstId` and `lastId` count
checkpoints for the summary read. The summary receipt is
`{scope, after, end, coverageEnd, count, sha256}`: `after` is the group's
current Origin summary cursor, `end` the last returned checkpoint ID (equal to
`after` when there is none), `coverageEnd` the coverage C of the same snapshot,
and `sha256` hashes stable checkpoint fields. The raw receipt is
`{scope, after, end, count, sha256}`: `after` is max(current Origin raw cursor,
`--after`), `end` the last returned row when the limit stopped the read and
otherwise the snapshot's upper bound, and `sha256` hashes the same projected
conversation fields as `batch`. `origin-cursor.js advance` recomputes both from
the database. The combined Origin read (neither `--summaries-only` nor
`--raw-only`) rejects `--out`.

Create a unique private directory with `mktemp -d` (0700) and place exports
inside it, never at reusable shared `/tmp` paths. Remove only this run's private
directory and its files with `rm -r "<absolute path of this run's private directory>"`
on success or failure before releasing the Sync token, including after
TOKEN_MISMATCH under the common failure rules. Do not add `-f`; report cleanup
failure. Do not redirect a second copy of the text.
Read long single lines by bytes: `dd if="<absolute path>" bs=1 skip=0
count=8192 status=none`, then skip=8188, 16376, and so on, with four-byte overlap
for UTF-8. Read the actual text for every range and record `[start,end)` ranges
through the reported file size in the Sync result. Truncation requires smaller
ranges and rereading; hashes, grep or word counts do not establish a full read.

### Required file verification

For every exported file and every listed input with byte/hash metadata, complete
these numbered steps before summarizing, checkpointing or advancing its cursor:

1. Read the entire file in bounded byte ranges and record every `[start,end)`.
   Truncated output is unread; reduce the range and reread it.
2. After reading the final text range, also display that same range with
   `dd if="<returned absolute path>" bs=1 skip=<final-start> count=<final-count> status=none | od -An -v -c`.
   Use the final range's start and byte count from the ledger. This makes every
   trailing space, tab and newline visible; plain command output may trim them.
   If this output is truncated, split the range and reread it with the same
   `od -An -v -c` display. This supplements the text read and does not replace it.
3. Compute the actual file size with `wc -c < "<returned absolute path>"` and
   SHA-256 with `shasum -a 256 "<returned absolute path>"`. Compare both actual
   values with that file's metadata `bytes` and `sha256`. In the Sync result,
   report the actual byte count and SHA-256 for each file and explicitly state
   that both match its metadata. Missing verification, missing report evidence
   or any mismatch makes this Sync run a failure; follow the existing failure
   and release rules, and do not advance that input or claim success.

File SHA-256 is distinct from the batch/summary/raw receipt hash; do not compare
file bytes against a receipt hash. A range ledger alone does not satisfy step 3.

All message content is projected before text/JSON formatting, absorbed preview
budgets or `--out` file writes. Valid structured content becomes fallbackText
plus a short C4 reference; invalid marked content becomes an error marker with
the source C4 ID and no raw payload. Ordinary text remains byte-compatible.
`--origin-sync --raw-only` selects conversations instead of checkpoint summaries;
it does not bypass projection. Absorbed `--field endpoint` still returns the
original routing field; `--field text` and its byte/truncation metadata describe
the projected text. C4 storage and authorized original-body/reconciliation APIs
remain separate and unchanged.

## Output

Outputs to stdout:
1. Last checkpoint summary (if exists)
2. Formatted conversations in the specified range (chronological order). With `--since`, the header shows the resolved UTC start time and the id range found, for use with `--begin`/`--end`.

Range and `--since` text may end with a counted reminder and a complete internal-message template for each foreign session group. Reminders are absent when `ZYLOS_SESSION_GROUP` is missing or empty, the caller is `origin`, or all returned rows belong to the caller (or there are no rows). JSON and Sync reads (`--unsummarized`, all `--origin-sync` forms) never append reminders; `c4-db.js recent` always retains its JSON output, including without `--json`.

## Example

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin 10 --end 50
```

Output:
```
[Last Checkpoint Summary] Synced conversations 1-9
[Conversations] (id 10 ~ 50)
[2025-01-15 10:00:00] IN (telegram:8101553026):
hello

[2025-01-15 10:01:00] OUT (telegram:8101553026):
Hi there!
```

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --since 24h
```

Output:
```
[Last Checkpoint Summary] Synced conversations 1-9
[Conversations] (since 2025-01-14 10:30:00 UTC, id 10 ~ 50)
[2025-01-15 10:00:00] IN (telegram:8101553026):
hello
...
```
