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
is selected. Stdout contains only export metadata: `path`, `count`, `firstId`,
`lastId`, `bytes`, `sha256`, and `batch` (inside the usual data envelope with
`--json`). Read the entire file and verify its byte count and SHA-256 before
summarizing it. `sha256` hashes the file bytes; `batch.sha256` instead hashes
stable projected conversation fields and is the receipt used by checkpoint
verification. The receipt's `after` honors actual coverage and `--after`;
its `end` is the last returned row ID, or the query's upper bound for an empty
batch. A limit cannot authorize checkpointing unread rows. No receipt is stored
on the host. An export with a reversed receipt range is rejected.

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
