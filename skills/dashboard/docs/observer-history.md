# Observer history

The **History** view in Observer shows the runtime's saved conversation records.
It supports Claude Code and Codex, including previous sessions, messages, replies,
tool input/results, attachments and session markers. History is available locally
and through Fleet to administrators when Observer is installed and enabled.

Switching between **Live terminal** and **History** preserves the live connection.
History reads transcript files; it never scrolls the terminal, sends agent input,
creates a terminal lease or changes runtime files. Leaving Observer stops history
polling. Polling also pauses while the page is hidden or scrolled away from the
bottom. Use **Latest** to return to the current session.

Select a session to read earlier conversations. Claude subagents are listed below
their parent; missing subagent metadata does not hide their records. Codex lists
only main sessions already registered by Dashboard hooks. Independent Codex
subagent transcripts are not listed in this version.

Long fields can be expanded, then loaded in additional chunks or in full. When a
runtime retained full output separately, History recovers it from the permitted
C4 attachment or tool-results directory. Missing or disallowed files are marked
unavailable while the saved preview remains visible. Large JSONL records are
indexed without parsing until explicitly expanded. Search operates on redacted
text within the selected session; oversized deferred records must first be opened
to inspect their content. Images and PDFs can be opened or downloaded separately.
Unknown record types are available with **Show internal records**; runtime
reasoning is not displayed.

## Redaction

All textual content is redacted on the instance owning the transcript, before
previews, content chunking and searching. This applies to local and Fleet viewing;
there is no reveal-original switch. The detector combines known credentials from
`.env` and component configuration, Dashboard credential formats, pinned Gitleaks
and selected Betterleaks rules, and structural credential fields/headers/URLs.
Markers identify a rule/source and length, with only public vendor prefixes
retained where applicable. Email addresses and phone numbers are not intentionally
masked. Every uncached text field is scanned in a worker, with a deadline covering
queue time and execution. If redaction fails or times out, content is replaced
with an unavailable message.

Binary images/PDFs and encoded credentials are outside textual redaction coverage.
The live terminal is also outside this feature's redaction scope. Fleet retains
its existing response guard and may reject a binary response containing Dashboard
credential text. Pattern detection cannot guarantee identification of every
possible credential format.

An administrator can add exact false-positive values to
`history.redactionAllowlist` in Dashboard's `config.json`. Allowlisting never
bypasses the Dashboard credential layer. Rules are bundled with the release;
there are no runtime downloads or credential validation network calls. See
[rule provenance and rebuild instructions](../src/lib/redaction/vendor/README.md).

## Read-only API

All four endpoints require the existing Observer admin authentication:

| GET route under `/api/observer/history/` | Parameters |
| --- | --- |
| `sessions` | None |
| `entries` | `session`, one of `before` / `after` / `around`, `limit` (1–200), `internal=1` |
| `content` | `session`, `entry`, `field`, `offset` |
| `search` | `session`, `q` (2–200 characters), `before`, `limit` (1–200) |

Session IDs are resolved server-side; clients cannot request arbitrary file paths.
Entry cursors identify indexed line offsets, with a block suffix where needed.
Responses are `no-store`. Text offsets/totals use JavaScript string units, measured
after redaction; chunks are limited to 256 KiB UTF-8 and never split a Unicode
scalar. `next: null` marks the final chunk. Polling returns new `entries` plus
`updates` for older tool entries whose results arrived later. Deferred content
responses include an `expandedEntry` descriptor for newly discovered fields and
attachments.

Only PNG, JPEG, GIF and WebP use inline responses, with `nosniff` and sandbox CSP.
Other media are downloads. History never broadcasts transcript content through
the ordinary Dashboard SSE stream.
