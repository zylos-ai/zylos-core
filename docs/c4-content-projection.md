# C4 model text projection

`projectC4Content(content, { c4Id })` returns a string for model-facing readers.
The public Core entry is `cli/lib/content-projection.js`; it exports only
`projectC4Content`. Core code may also import the implementation at
`skills/comm-bridge/scripts/c4-content-projection.js`.

```js
import { projectC4Content } from './content-projection.js';
const text = projectC4Content(row.content, { c4Id: row.id });
const preview = text.slice(0, budget);
```

Components that already resolve the installed Core `cli/lib/config.js` can
import `content-projection.js` from that same directory. Loading this entry
initializes neither configuration nor C4 storage. No Dashboard code, installed
component directory, network, or optional component loader is consulted.

Recognition and validation use the shared `c4-content-schema.js` parser. Any
unmarked text, including ordinary JSON and oversized ordinary history, is
returned verbatim. Valid envelopes return their `fallbackText` followed by
`[C4 messageId=... interruptId=...; c4_id=...]` (interruptId only when present).
Inbound answer fallback text already contains its saved question summary and
readable answer. Blocks, host metadata, action payloads, answer IDs, and Core's
suppression annotation are not added to model text. This applies to both
directions and every channel; direction/channel do not select a different parser.

Invalid marked content returns `[C4 content invalid; c4_id=...]`. If its framed
JSON object has a qualified nonempty `fallbackText` string (at most 16000 Unicode
characters), the projection prepends that literal text and a newline, including
for unknown versions or bad references. Invalid framing, invalid suffixes,
oversized envelopes, or missing/unqualified fallback text retain only the marker.
This projection serves both IM text and Agent-readable history: both see the
qualified explanation while the envelope remains invalid. No other payload or
parser exception is echoed. Pass the authoritative C4 row ID for
original-record lookup; absent or invalid IDs display `unavailable`. IDs accept
positive safe integers or canonical positive decimal strings up to SQLite's
signed 64-bit maximum. This reference is a locator, not access authorization.

Always project the complete content before applying any caller length budget,
formatting, preview, or spill policy. The projector has no truncation policy and
never writes the raw content. Authorized Dashboard original-body reads and C4
storage remain separate. Reader migrations are separate changes; this module
alone does not switch existing readers or enable structured production.
