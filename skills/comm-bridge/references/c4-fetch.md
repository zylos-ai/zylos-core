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
